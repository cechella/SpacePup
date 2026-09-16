"""
circuit_breaker.py — Circuit Breaker por broker (Autoscan Bot)

Protege o sistema contra brokers com falhas consecutivas de execução,
bloqueando novas ordens temporariamente (OPEN) e testando a recuperação (HALF_OPEN).

Estados:
  CLOSED    — normal, ordens permitidas
  OPEN      — falhas consecutivas → ordens bloqueadas por cb_timeout_open_s
  HALF_OPEN — timeout expirou → aceita 1 ordem de teste por vez

Parâmetros lidos exclusivamente do Supabase (broker_health_config):
  cb_falhas_para_open    : falhas consecutivas para abrir
  cb_timeout_open_s      : segundos em OPEN antes de tentar HALF_OPEN
  cb_sucessos_para_close : sucessos em HALF_OPEN para fechar (CLOSED)

NENHUM valor hardcoded.
"""

import logging
from datetime import datetime, timezone, timedelta
from enum import Enum
from typing import Optional

logger = logging.getLogger(__name__)


class EstadoCB(str, Enum):
    """Estados do circuit breaker."""
    CLOSED    = 'CLOSED'
    OPEN      = 'OPEN'
    HALF_OPEN = 'HALF_OPEN'


class CircuitBreaker:
    """
    Circuit breaker por broker.

    Uma instância por broker. Chame `registrar_falha()` após cada ordem que
    falhar no broker, e `registrar_sucesso()` após cada ordem bem-sucedida.
    Use `pode_enviar_ordem()` antes de cada envio de ordem.
    """

    def __init__(self, broker_id: str):
        self.broker_id       = broker_id
        self.estado          = EstadoCB.CLOSED
        self.falhas_consec   = 0   # falhas consecutivas no estado CLOSED/HALF_OPEN
        self.sucessos_consec = 0   # sucessos consecutivos em HALF_OPEN
        self.aberto_desde    = None  # timestamp de quando abriu (para calcular timeout)

    def pode_enviar_ordem(self, config: dict) -> bool:
        """
        Verifica se o broker está apto a receber uma nova ordem.

        Em CLOSED: sempre pode.
        Em OPEN: verifica se o timeout expirou para tentar HALF_OPEN.
        Em HALF_OPEN: permite apenas 1 ordem de teste por vez.

        Parâmetros:
          config : dicionário broker_health_config lido do Supabase
        """
        self._validar_config(config)

        if self.estado == EstadoCB.CLOSED:
            return True

        if self.estado == EstadoCB.OPEN:
            timeout = float(config['cb_timeout_open_s'])
            if self.aberto_desde and (
                datetime.now(timezone.utc) - self.aberto_desde
            ).total_seconds() >= timeout:
                logger.info(
                    f"[{self.broker_id}] Circuit Breaker: OPEN → HALF_OPEN "
                    f"(timeout de {timeout}s expirou)"
                )
                self.estado = EstadoCB.HALF_OPEN
                self.falhas_consec   = 0
                self.sucessos_consec = 0
                return True  # permite a ordem de teste
            return False  # ainda em OPEN

        if self.estado == EstadoCB.HALF_OPEN:
            # Em HALF_OPEN permite apenas 1 ordem de cada vez
            return True

        return False

    def registrar_sucesso(self, config: dict) -> None:
        """
        Registra sucesso de execução.

        Em HALF_OPEN: acumula sucessos; fecha o CB após cb_sucessos_para_close.
        Em CLOSED: reseta falhas consecutivas.
        """
        self._validar_config(config)

        if self.estado == EstadoCB.CLOSED:
            self.falhas_consec = 0
            return

        if self.estado == EstadoCB.HALF_OPEN:
            self.sucessos_consec += 1
            meta = int(config['cb_sucessos_para_close'])
            logger.info(
                f"[{self.broker_id}] Circuit Breaker HALF_OPEN: "
                f"{self.sucessos_consec}/{meta} sucessos"
            )
            if self.sucessos_consec >= meta:
                self._fechar()
            return

    def registrar_falha(self, config: dict) -> None:
        """
        Registra falha de execução.

        Em CLOSED: acumula falhas; abre o CB após cb_falhas_para_open.
        Em HALF_OPEN: qualquer falha retorna ao estado OPEN.
        """
        self._validar_config(config)

        if self.estado == EstadoCB.OPEN:
            return  # já aberto, ignora

        if self.estado == EstadoCB.HALF_OPEN:
            logger.warning(
                f"[{self.broker_id}] Circuit Breaker HALF_OPEN: falha detectada → OPEN novamente"
            )
            self._abrir()
            return

        # Estado CLOSED
        self.falhas_consec += 1
        meta = int(config['cb_falhas_para_open'])
        logger.warning(
            f"[{self.broker_id}] Circuit Breaker: "
            f"{self.falhas_consec}/{meta} falhas consecutivas"
        )
        if self.falhas_consec >= meta:
            self._abrir()

    def estado_str(self) -> str:
        return self.estado.value

    def _abrir(self) -> None:
        self.estado       = EstadoCB.OPEN
        self.aberto_desde = datetime.now(timezone.utc)
        self.sucessos_consec = 0
        logger.error(
            f"[{self.broker_id}] Circuit Breaker ABERTO — broker bloqueado temporariamente"
        )

    def _fechar(self) -> None:
        self.estado          = EstadoCB.CLOSED
        self.falhas_consec   = 0
        self.sucessos_consec = 0
        self.aberto_desde    = None
        logger.info(f"[{self.broker_id}] Circuit Breaker FECHADO — broker liberado")

    _CHAVES_OBRIGATORIAS = [
        'cb_falhas_para_open', 'cb_timeout_open_s', 'cb_sucessos_para_close',
    ]

    def _validar_config(self, config: dict) -> None:
        faltando = [k for k in self._CHAVES_OBRIGATORIAS if k not in config]
        if faltando:
            raise KeyError(
                f"[{self.broker_id}] Parâmetros CB ausentes no Supabase: {faltando}"
            )
