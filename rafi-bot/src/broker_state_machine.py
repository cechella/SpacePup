"""
broker_state_machine.py — Máquina de estados do broker (Autoscan Bot)

Gerencia as transições entre os 6 estados operacionais de cada broker,
aplicando histerese (N amostras consecutivas antes de transicionar).

Estados possíveis:
  ACTIVE            — score ≥ threshold_active → alocação plena
  ACTIVE_REDUCED    — score ≥ threshold_active_reduced → alocação –50%
  STANDBY           — score ≥ threshold_standby → sem novas ordens
  QUARANTINED       — quarentena ativa (tempo mínimo configurado)
  DISABLED_BY_HEALTH — score < threshold_disabled → desabilitado automaticamente
  MANUALLY_DISABLED — desabilitado pelo operador via Admin Panel

Todos os thresholds e o número de amostras para histerese (N) são lidos
exclusivamente do Supabase (broker_health_config). NENHUM valor hardcoded.
"""

import logging
from datetime import datetime, timezone, timedelta
from enum import Enum
from typing import Optional

from .broker_health_engine import HealthScore

logger = logging.getLogger(__name__)


class EstadoBroker(str, Enum):
    """Estados operacionais de um broker."""
    ACTIVE              = 'ACTIVE'
    ACTIVE_REDUCED      = 'ACTIVE_REDUCED'
    STANDBY             = 'STANDBY'
    QUARANTINED         = 'QUARANTINED'
    DISABLED_BY_HEALTH  = 'DISABLED_BY_HEALTH'
    MANUALLY_DISABLED   = 'MANUALLY_DISABLED'


class BrokerStateMachine:
    """
    Determina o estado operacional de um broker com base no health score atual
    e no histórico de amostras recentes (histerese).

    Uma instância por broker. Mantém os contadores de histerese em memória
    e sincroniza com o Supabase (broker_health_state) a cada ciclo.
    """

    def __init__(self, broker_id: str):
        self.broker_id        = broker_id
        self.estado_atual     = EstadoBroker.STANDBY
        self.estado_anterior  = None
        self.consecutivos_ok  = 0   # amostras consecutivas acima do threshold
        self.consecutivos_ruim = 0  # amostras consecutivas abaixo do threshold
        self.quarentena_ate   = None
        self.override_manual  = None
        self.motivo_estado    = "Inicialização"

    def avaliar(self, score: HealthScore, config: dict) -> EstadoBroker:
        """
        Avalia o novo score e decide se o estado deve transicionar.

        Parâmetros:
          score  : HealthScore calculado pelo BrokerHealthEngine
          config : dicionário broker_health_config lido do Supabase

        Retorna o estado atual (pode ser o mesmo ou um novo após transição).
        NUNCA usa defaults hardcoded — lança KeyError se config estiver incompleto.
        """
        self._validar_config(config)

        # Override manual tem prioridade absoluta
        if self.override_manual == 'MANUAL_DISABLED':
            return self._aplicar(EstadoBroker.MANUALLY_DISABLED, "Override manual: desabilitado")
        if self.override_manual == 'MANUAL_ACTIVE':
            # Override ativo: ignora thresholds mas registra score
            return self._aplicar(EstadoBroker.ACTIVE, "Override manual: forçado ativo")

        # Quarentena ainda ativa?
        if self.quarentena_ate and datetime.now(timezone.utc) < self.quarentena_ate:
            restante = (self.quarentena_ate - datetime.now(timezone.utc)).total_seconds()
            return self._aplicar(
                EstadoBroker.QUARANTINED,
                f"Quarentena ativa por mais {restante:.0f}s"
            )

        n_amostras = int(config['histerese_n_amostras'])
        th_active   = float(config['threshold_active'])
        th_reduced  = float(config['threshold_active_reduced'])
        th_standby  = float(config['threshold_standby'])
        th_disabled = float(config['threshold_disabled'])

        s = score.health_score

        # Determina o estado alvo com base no score atual
        if s >= th_active:
            estado_alvo = EstadoBroker.ACTIVE
            motivo = f"Score {s:.1f} ≥ threshold_active {th_active}"
        elif s >= th_reduced:
            estado_alvo = EstadoBroker.ACTIVE_REDUCED
            motivo = f"Score {s:.1f} ≥ threshold_active_reduced {th_reduced}"
        elif s >= th_standby:
            estado_alvo = EstadoBroker.STANDBY
            motivo = f"Score {s:.1f} ≥ threshold_standby {th_standby}"
        elif s >= th_disabled:
            estado_alvo = EstadoBroker.STANDBY
            motivo = f"Score {s:.1f} baixo mas acima de threshold_disabled {th_disabled}"
        else:
            estado_alvo = EstadoBroker.DISABLED_BY_HEALTH
            motivo = f"Score {s:.1f} < threshold_disabled {th_disabled}"

        # Histerese: só transiciona após N amostras consecutivas no novo estado
        if estado_alvo == self.estado_atual:
            # Estado não muda: reseta contadores
            self.consecutivos_ok   = 0
            self.consecutivos_ruim = 0
            return self.estado_atual

        # Verificar direção da mudança (melhora ou piora)
        estados_bons = {EstadoBroker.ACTIVE, EstadoBroker.ACTIVE_REDUCED}
        estados_ruins = {EstadoBroker.DISABLED_BY_HEALTH, EstadoBroker.QUARANTINED}

        eh_melhora = estado_alvo in estados_bons or (
            estado_alvo == EstadoBroker.STANDBY and self.estado_atual in estados_ruins
        )

        if eh_melhora:
            self.consecutivos_ok += 1
            self.consecutivos_ruim = 0
            if self.consecutivos_ok >= n_amostras:
                self.consecutivos_ok = 0
                logger.info(
                    f"[{self.broker_id}] Transição {self.estado_atual} → {estado_alvo} "
                    f"após {n_amostras} amostras consecutivas melhores | {motivo}"
                )
                return self._aplicar(estado_alvo, motivo)
            else:
                logger.debug(
                    f"[{self.broker_id}] Melhora detectada ({self.consecutivos_ok}/{n_amostras}): "
                    f"{estado_alvo} | {motivo}"
                )
        else:
            self.consecutivos_ruim += 1
            self.consecutivos_ok = 0
            if self.consecutivos_ruim >= n_amostras:
                self.consecutivos_ruim = 0
                logger.warning(
                    f"[{self.broker_id}] Transição {self.estado_atual} → {estado_alvo} "
                    f"após {n_amostras} amostras consecutivas ruins | {motivo}"
                )
                return self._aplicar(estado_alvo, motivo)
            else:
                logger.debug(
                    f"[{self.broker_id}] Piora detectada ({self.consecutivos_ruim}/{n_amostras}): "
                    f"{estado_alvo} | {motivo}"
                )

        return self.estado_atual

    def iniciar_quarentena(self, config: dict, motivo: str = "Evento severo") -> None:
        """
        Coloca o broker em quarentena pelo tempo mínimo configurado no Supabase.
        Lança KeyError se quarentena_minutos não estiver na config.
        """
        minutos = float(config['quarentena_minutos'])
        self.quarentena_ate = datetime.now(timezone.utc) + timedelta(minutes=minutos)
        logger.warning(
            f"[{self.broker_id}] Quarentena iniciada por {minutos:.0f} min | {motivo}"
        )
        self._aplicar(EstadoBroker.QUARANTINED, motivo)

    def aplicar_override_manual(self, override: Optional[str]) -> None:
        """
        Define override manual do estado.
        Valores: 'MANUAL_ACTIVE' | 'MANUAL_DISABLED' | None (remove override).
        """
        self.override_manual = override
        if override:
            logger.info(f"[{self.broker_id}] Override manual aplicado: {override}")
        else:
            logger.info(f"[{self.broker_id}] Override manual removido")

    def pode_receber_ordens(self) -> bool:
        """Retorna True se o broker está em estado que aceita novas ordens."""
        return self.estado_atual == EstadoBroker.ACTIVE

    def pode_receber_ordens_reduzidas(self) -> bool:
        """Retorna True se o broker aceita ordens com alocação reduzida (–50%)."""
        return self.estado_atual == EstadoBroker.ACTIVE_REDUCED

    def _aplicar(self, novo_estado: EstadoBroker, motivo: str) -> EstadoBroker:
        """Aplica a transição de estado e atualiza metadados."""
        if novo_estado != self.estado_atual:
            self.estado_anterior = self.estado_atual
        self.estado_atual  = novo_estado
        self.motivo_estado = motivo
        return novo_estado

    _CHAVES_OBRIGATORIAS = [
        'histerese_n_amostras', 'threshold_active', 'threshold_active_reduced',
        'threshold_standby', 'threshold_disabled',
    ]

    def _validar_config(self, config: dict) -> None:
        faltando = [k for k in self._CHAVES_OBRIGATORIAS if k not in config]
        if faltando:
            raise KeyError(
                f"[{self.broker_id}] Parâmetros ausentes no Supabase: {faltando}"
            )
