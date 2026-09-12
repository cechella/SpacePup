"""
allocation_engine.py — Motor de alocação dinâmica por broker (Autoscan Bot)

Calcula o percentual de capital que cada broker pode receber, respeitando:
  - max_allocation_pct: limite máximo por broker (lido do Supabase)
  - Estado do broker: ACTIVE_REDUCED recebe 50% da alocação normal
  - Total alocado nunca ultrapassa 100% entre todos os brokers

Regra crítica: max_allocation_pct lido exclusivamente do Supabase.
NENHUM limite hardcoded.
"""

import logging
from typing import Dict, List

from .broker_ranking import BrokerRankEntry
from .broker_state_machine import EstadoBroker

logger = logging.getLogger(__name__)


class AllocationEngine:
    """
    Calcula a alocação percentual de capital por broker.

    Entrada: lista de BrokerRankEntry com estados e scores atuais.
    Saída  : dicionário {broker_id: allocation_pct} para todos os brokers.
    """

    def calcular(self, entries: List[BrokerRankEntry], config: dict) -> Dict[str, float]:
        """
        Distribui a alocação entre os brokers ativos.

        Parâmetros:
          entries : lista de BrokerRankEntry (mesma usada pelo DynamicRanking)
          config  : dicionário broker_health_config lido do Supabase

        Retorna dicionário {broker_id: pct} onde pct está em 0–100.
        Lança KeyError se max_allocation_pct não estiver no config.
        """
        if 'max_allocation_pct' not in config:
            raise KeyError(
                "max_allocation_pct ausente no broker_health_config do Supabase. "
                "Execute a migração e verifique o Admin Panel."
            )

        max_pct = float(config['max_allocation_pct'])  # limite por broker
        alocacao: Dict[str, float] = {}

        estados_ativos = {EstadoBroker.ACTIVE, EstadoBroker.ACTIVE_REDUCED}

        for entry in entries:
            if entry.estado not in estados_ativos:
                alocacao[entry.broker_id] = 0.0
                continue

            # ACTIVE_REDUCED recebe metade da alocação máxima
            pct = max_pct if entry.estado == EstadoBroker.ACTIVE else max_pct * 0.5
            alocacao[entry.broker_id] = pct

        # Garante que o total não ultrapassa 100%
        total = sum(alocacao.values())
        if total > 100.0:
            fator = 100.0 / total
            logger.warning(
                f"Alocação total ({total:.1f}%) excede 100% — "
                f"reduzindo proporcionalmente (fator={fator:.3f})"
            )
            alocacao = {bid: round(pct * fator, 2) for bid, pct in alocacao.items()}

        logger.info(
            "Alocação calculada: " +
            " | ".join(f"{bid}={pct:.1f}%" for bid, pct in alocacao.items())
        )
        return alocacao

    def fator_lote(self, broker_id: str, alocacao: Dict[str, float],
                   max_allocation_pct: float) -> float:
        """
        Retorna o fator multiplicador de lote para este broker (0.0–1.0).

        Exemplo: max_allocation=55%, broker_pct=27.5% (ACTIVE_REDUCED) → fator=0.5
        Usado pelo risk_manager para ajustar o lote antes de enviar a ordem.
        """
        pct = alocacao.get(broker_id, 0.0)
        if max_allocation_pct <= 0:
            return 0.0
        return round(pct / max_allocation_pct, 4)
