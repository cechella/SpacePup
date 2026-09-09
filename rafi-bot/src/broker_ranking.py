"""
broker_ranking.py — Ranking dinâmico de brokers (Autoscan Bot)

Ordena os brokers habilitados por health score para determinar qual recebe
cada sinal de trading. O broker #1 no ranking recebe o sinal; em caso de
falha ou indisponibilidade, passa para o #2, depois #3.

Critérios de ordenação (em ordem de prioridade):
  1. Estado operacional (ACTIVE > ACTIVE_REDUCED > STANDBY > outros)
  2. Circuit Breaker fechado (CLOSED > HALF_OPEN > OPEN)
  3. Health score composto (maior primeiro)
  4. Prioridade manual (broker_priority da tabela rafi_brokers — desempate)

A prioridade manual apenas decide empates — não sobrepõe o health score.
"""

import logging
from dataclasses import dataclass
from typing import List, Optional

from .broker_state_machine import EstadoBroker
from .circuit_breaker import EstadoCB

logger = logging.getLogger(__name__)


@dataclass
class BrokerRankEntry:
    """Representa um broker na lista de ranking."""
    broker_id: str
    health_score: float
    estado: EstadoBroker
    circuit_breaker: EstadoCB
    broker_priority: int        # prioridade fixa (1=mais prioritário) para desempate
    allocation_pct: float = 0.0  # percentual atual de alocação


# Ordenação numérica dos estados (maior = mais preferível para receber ordens)
_PESO_ESTADO = {
    EstadoBroker.ACTIVE:             4,
    EstadoBroker.ACTIVE_REDUCED:     3,
    EstadoBroker.STANDBY:            2,
    EstadoBroker.QUARANTINED:        1,
    EstadoBroker.DISABLED_BY_HEALTH: 0,
    EstadoBroker.MANUALLY_DISABLED:  0,
}

_PESO_CB = {
    EstadoCB.CLOSED:    2,
    EstadoCB.HALF_OPEN: 1,
    EstadoCB.OPEN:      0,
}


class DynamicRanking:
    """
    Mantém e atualiza o ranking dinâmico de brokers.

    Uso:
        ranking = DynamicRanking()
        ranking.atualizar(entries)
        broker_id = ranking.melhor_broker_para_ordem()
    """

    def __init__(self):
        self._entries: List[BrokerRankEntry] = []

    def atualizar(self, entries: List[BrokerRankEntry]) -> None:
        """
        Recebe a lista de brokers com seus estados e scores atuais
        e recalcula a ordem de ranking.
        """
        self._entries = sorted(
            entries,
            key=lambda e: (
                _PESO_ESTADO.get(e.estado, 0),    # 1º critério: estado
                _PESO_CB.get(e.circuit_breaker, 0),  # 2º critério: CB
                e.health_score,                    # 3º critério: score
                -e.broker_priority,                # 4º critério: prioridade (menor = melhor)
            ),
            reverse=True,  # maior valor = melhor posição
        )

        self._logar_ranking()

    def melhor_broker_para_ordem(self) -> Optional[str]:
        """
        Retorna o broker_id do melhor broker apto a receber uma nova ordem.
        Considera apenas brokers em estado ACTIVE ou ACTIVE_REDUCED com CB CLOSED/HALF_OPEN.
        Retorna None se nenhum broker estiver disponível.
        """
        estados_aceitos = {EstadoBroker.ACTIVE, EstadoBroker.ACTIVE_REDUCED}
        cb_aceitos = {EstadoCB.CLOSED, EstadoCB.HALF_OPEN}

        for entry in self._entries:
            if entry.estado in estados_aceitos and entry.circuit_breaker in cb_aceitos:
                return entry.broker_id

        logger.warning("Nenhum broker disponível para receber ordens neste momento")
        return None

    def lista_ordenada(self) -> List[BrokerRankEntry]:
        """Retorna cópia do ranking atual em ordem decrescente de preferência."""
        return list(self._entries)

    def obter_entry(self, broker_id: str) -> Optional[BrokerRankEntry]:
        """Retorna o BrokerRankEntry de um broker específico, ou None."""
        for e in self._entries:
            if e.broker_id == broker_id:
                return e
        return None

    def _logar_ranking(self) -> None:
        if not self._entries:
            return
        linhas = [f"  #{i+1} {e.broker_id}: score={e.health_score:.1f} "
                  f"estado={e.estado.value} cb={e.circuit_breaker.value}"
                  for i, e in enumerate(self._entries)]
        logger.info("Ranking de brokers atualizado:\n" + "\n".join(linhas))
