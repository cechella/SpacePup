"""
broker_coordinator.py — Coordenador do Broker Health Engine (Autoscan Bot)

Orquestra todos os módulos do sistema de saúde multi-broker:
  1. BrokerTelemetryThread — coleta métricas em background
  2. BrokerHealthEngine    — calcula scores a partir das métricas
  3. BrokerStateMachine    — determina estado operacional com histerese
  4. CircuitBreaker        — protege contra falhas consecutivas
  5. DynamicRanking        — ordena brokers por preferência
  6. AllocationEngine      — define % de alocação por broker

O BrokerCoordinator é instanciado pelo executor.py de cada processo de broker.
No modelo de processo separado por broker (--broker pepperstone), cada processo
tem seu próprio coordenador gerenciando apenas aquele broker.

Supabase é consultado no início de cada ciclo de avaliação para obter os
parâmetros atualizados. Se o Supabase estiver indisponível: BOT PARA.
"""

import logging
import threading
import time
from datetime import datetime, timezone
from typing import Optional

from .broker_health_engine import BrokerHealthEngine, HealthScore
from .broker_state_machine import BrokerStateMachine, EstadoBroker
from .circuit_breaker import CircuitBreaker, EstadoCB
from .broker_ranking import DynamicRanking, BrokerRankEntry
from .allocation_engine import AllocationEngine
from .broker_telemetry import BrokerTelemetryThread

logger = logging.getLogger(__name__)


class BrokerCoordinator:
    """
    Coordenador do Broker Health Engine para um único broker.

    Uma instância por processo de bot (um por broker). O coordenador:
      - Inicia a thread de telemetria em background
      - Executa ciclos de avaliação de health a cada intervalo configurado
      - Sincroniza o estado com o Supabase após cada ciclo
      - Expõe métodos para o executor consultar disponibilidade e registrar resultados
    """

    def __init__(self, broker_id: str, mt5_client, simbolo: str, supabase_sync):
        """
        Parâmetros:
          broker_id    : identificador do broker (ex.: 'pepperstone')
          mt5_client   : instância de ClienteMT5 (já conectada ao broker)
          simbolo      : par sendo operado (ex.: 'EURUSD')
          supabase_sync: módulo supabase_sync (para config e publicação)
        """
        self.broker_id   = broker_id
        self.mt5         = mt5_client
        self.simbolo     = simbolo
        self.sync        = supabase_sync

        # Módulos internos
        self._engine      = BrokerHealthEngine()
        self._state_mach  = BrokerStateMachine(broker_id)
        self._cb          = CircuitBreaker(broker_id)
        self._ranking     = DynamicRanking()
        self._alloc       = AllocationEngine()

        # Thread de telemetria (daemon)
        self._telemetry_thread: Optional[BrokerTelemetryThread] = None

        # Último score calculado (para referência do executor)
        self._ultimo_score: Optional[HealthScore] = None
        self._ultimo_config: dict = {}

        # Lock para acesso ao estado do circuit breaker (thread-safe)
        self._lock = threading.Lock()

    # ── Ciclo de vida ──────────────────────────────────────────────────────────

    def iniciar(self) -> None:
        """
        Inicia o sistema de health:
          1. Carrega configuração inicial do Supabase (HALT se indisponível)
          2. Carrega o estado persistido do Supabase (broker_health_state)
          3. Inicia a thread de telemetria em background

        Lança RuntimeError se o Supabase não estiver disponível na inicialização.
        """
        logger.info(f"[{self.broker_id}] Iniciando Broker Health Engine...")

        # Carga inicial de config — sem Supabase = HALT
        try:
            config = self.sync.carregar_config_broker_health()
            self._ultimo_config = config
        except Exception as e:
            raise RuntimeError(
                f"[{self.broker_id}] Supabase indisponível ao iniciar BrokerCoordinator: {e}. "
                f"Bot não pode operar sem configuração."
            )

        # Restaura estado persistido do Supabase (se houver)
        try:
            estado_persistido = self.sync.carregar_estado_broker(self.broker_id)
            if estado_persistido:
                estado_str = estado_persistido.get('estado', 'STANDBY')
                cb_str     = estado_persistido.get('circuit_breaker', 'CLOSED')
                try:
                    self._state_mach.estado_atual = EstadoBroker(estado_str)
                    self._cb.estado = EstadoCB(cb_str)
                    logger.info(
                        f"[{self.broker_id}] Estado restaurado do Supabase: "
                        f"estado={estado_str} cb={cb_str}"
                    )
                except ValueError:
                    logger.warning(
                        f"[{self.broker_id}] Estado inválido no Supabase ({estado_str}) "
                        f"— usando STANDBY/CLOSED"
                    )
        except Exception as e:
            logger.warning(f"[{self.broker_id}] Não foi possível restaurar estado: {e}")

        # Inicia thread de telemetria
        self._telemetry_thread = BrokerTelemetryThread(
            broker_id=self.broker_id,
            mt5_client=self.mt5,
            simbolo=self.simbolo,
            supabase_sync=self.sync,
        )
        self._telemetry_thread.start()
        logger.info(f"[{self.broker_id}] Thread de telemetria iniciada")

    def parar(self) -> None:
        """Para a thread de telemetria de forma limpa (aguarda até 10s)."""
        if self._telemetry_thread and self._telemetry_thread.is_alive():
            self._telemetry_thread.parar()
            self._telemetry_thread.join(timeout=10)
            logger.info(f"[{self.broker_id}] Thread de telemetria encerrada")

    # ── Ciclo de avaliação de health ──────────────────────────────────────────

    def executar_ciclo_health(self) -> Optional[HealthScore]:
        """
        Executa um ciclo completo de avaliação de health:
          1. Carrega configuração atualizada do Supabase (HALT se indisponível)
          2. Busca a última métrica do Supabase (broker_health_metrics)
          3. Calcula o health score
          4. Avalia a transição de estado (com histerese)
          5. Atualiza o Supabase (broker_health_scores + broker_health_state)

        Retorna o HealthScore calculado, ou None se não houver métricas ainda.
        Lança RuntimeError se o Supabase estiver indisponível.
        """
        # Config sempre do Supabase — se falhar: HALT
        try:
            config = self.sync.carregar_config_broker_health()
            self._ultimo_config = config
        except Exception as e:
            raise RuntimeError(
                f"[{self.broker_id}] Supabase indisponível no ciclo de health: {e}. "
                f"Bot parando por segurança."
            )

        # Busca última métrica coletada
        try:
            metricas = self.sync.carregar_ultima_metrica_broker(self.broker_id)
        except Exception as e:
            logger.error(f"[{self.broker_id}] Erro ao buscar métricas do Supabase: {e}")
            metricas = None

        if metricas is None:
            logger.warning(
                f"[{self.broker_id}] Sem métricas disponíveis ainda — "
                f"mantendo estado {self._state_mach.estado_atual.value}"
            )
            return None

        # Calcula score
        score = self._engine.calcular(metricas, config)
        self._ultimo_score = score

        # Avalia estado (com histerese e circuit breaker)
        with self._lock:
            novo_estado = self._state_mach.avaliar(score, config)

        # Publica score e estado no Supabase
        try:
            self.sync.publicar_health_score(score)
            self.sync.publicar_estado_broker(
                broker_id=self.broker_id,
                estado=novo_estado.value,
                circuit_breaker=self._cb.estado.value,
                health_score=score.health_score,
                consecutivos_ok=self._state_mach.consecutivos_ok,
                consecutivos_ruim=self._state_mach.consecutivos_ruim,
                quarentena_ate=self._state_mach.quarentena_ate,
                override_manual=self._state_mach.override_manual,
                motivo_estado=self._state_mach.motivo_estado,
            )
        except Exception as e:
            logger.error(f"[{self.broker_id}] Falha ao publicar score/estado no Supabase: {e}")

        return score

    # ── Interface para o executor ─────────────────────────────────────────────

    def pode_receber_ordem(self) -> bool:
        """
        Retorna True se o broker está apto a receber uma nova ordem.
        Considera estado operacional E circuit breaker.
        """
        with self._lock:
            estado_ok = (
                self._state_mach.pode_receber_ordens() or
                self._state_mach.pode_receber_ordens_reduzidas()
            )
            cb_ok = self._cb.pode_enviar_ordem(self._ultimo_config) if self._ultimo_config else False
            return estado_ok and cb_ok

    def registrar_sucesso_ordem(self) -> None:
        """Chamado pelo executor após cada ordem enviada com sucesso."""
        with self._lock:
            if self._ultimo_config:
                self._cb.registrar_sucesso(self._ultimo_config)

    def registrar_falha_ordem(self) -> None:
        """Chamado pelo executor após cada falha de envio de ordem."""
        with self._lock:
            if self._ultimo_config:
                self._cb.registrar_falha(self._ultimo_config)
            # Falha de ordem também pode iniciar quarentena (se severa)
            # Por ora, apenas registra no CB — quarentena é iniciada pelo state_machine

    def fator_lote(self) -> float:
        """
        Retorna o fator multiplicador de lote (0.0–1.0) baseado no estado atual.

        ACTIVE         → 1.0 (alocação plena)
        ACTIVE_REDUCED → 0.5 (alocação reduzida)
        outros         → 0.0 (sem alocação)
        """
        with self._lock:
            if self._state_mach.pode_receber_ordens():
                return 1.0
            elif self._state_mach.pode_receber_ordens_reduzidas():
                return 0.5
            return 0.0

    def estado_atual(self) -> EstadoBroker:
        """Retorna o estado operacional atual do broker."""
        return self._state_mach.estado_atual

    def score_atual(self) -> Optional[float]:
        """Retorna o último health score calculado, ou None se ainda não calculado."""
        return self._ultimo_score.health_score if self._ultimo_score else None

    def aplicar_override_manual(self, override: Optional[str]) -> None:
        """
        Aplica override manual vindo do Admin Panel.
        Valores: 'MANUAL_ACTIVE' | 'MANUAL_DISABLED' | None (remove).
        """
        with self._lock:
            self._state_mach.aplicar_override_manual(override)
