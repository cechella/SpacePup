"""
signal_coordinator.py — Roteamento de sinais para a corretora vencedora do ranking.

Fluxo:
  1. Bot detecta sinal (candle fechado com setup válido).
  2. Chama SignalCoordinator.rotear_sinal().
  3. O coordinator consulta o DynamicRanking e publica na fila signals_pending
     do Supabase com broker_id = vencedor.
  4. O executor daquela corretora lê a fila e executa a ordem.
  5. Após execução, atualiza status para 'executed'.

Deduplicação:
  signal_id = "{candle_time}_{symbol}_{direction}" — PRIMARY KEY na tabela.
  Se o mesmo sinal chegar duas vezes (ex: restart do bot), o segundo INSERT
  falha silenciosamente. Nenhuma ordem duplicada é enviada.
"""

import logging
from datetime import datetime, timezone
from typing import Optional

from supabase import Client

from .broker_ranking import DynamicRanking, BrokerRankEntry
from .broker_coordinator import BrokerCoordinator

logger = logging.getLogger(__name__)

# Status possíveis de um sinal na fila
STATUS_PENDING   = 'pending'
STATUS_EXECUTED  = 'executed'
STATUS_CANCELLED = 'cancelled'
STATUS_FAILED    = 'failed'


class SignalCoordinator:
    """
    Roteia sinais de trading para a corretora vencedora do ranking dinâmico.

    Responsabilidades:
      - Determinar para qual broker vai cada sinal.
      - Gravar o sinal na fila signals_pending do Supabase.
      - Evitar ordens duplicadas via signal_id único.
      - Registrar no log qual broker ganhou e por quê.
      - Rejeitar brokers com margem insuficiente (margem_minima_usd).
    """

    def __init__(self, supabase: Client, ranking: DynamicRanking,
                 margem_minima_usd: float = 50.0):
        self._supa             = supabase
        self._ranking          = ranking
        self._margem_minima    = margem_minima_usd

    # ──────────────────────────────────────────────────────────
    # API pública
    # ──────────────────────────────────────────────────────────

    def rotear_sinal(
        self,
        symbol: str,
        direction: str,           # 'BUY' ou 'SELL'
        candle_time: datetime,    # horário UTC do fechamento do candle
        lot: float,
    ) -> Optional[str]:
        """
        Decide para qual corretora o sinal vai e publica na fila.

        Retorna o broker_id vencedor, ou None se nenhum broker estiver disponível.
        """
        signal_id = self._gerar_signal_id(candle_time, symbol, direction)

        broker_id = self._ranking.melhor_broker_para_ordem(self._margem_minima)
        if not broker_id:
            logger.warning(
                "SINAL DESCARTADO — nenhum broker disponível | "
                "signal_id=%s symbol=%s direction=%s",
                signal_id, symbol, direction,
            )
            return None

        publicado = self._publicar(
            signal_id=signal_id,
            broker_id=broker_id,
            symbol=symbol,
            direction=direction,
            candle_time=candle_time,
            lot=lot,
        )

        if publicado:
            entry = self._ranking.obter_entry(broker_id)
            score_str = f"score={entry.health_score:.1f}" if entry else "score=?"
            logger.info(
                "SINAL ROTEADO → %s | signal_id=%s symbol=%s dir=%s lot=%.2f %s",
                broker_id, signal_id, symbol, direction, lot, score_str,
            )
            return broker_id

        # INSERT falhou — provavelmente sinal duplicado (PK conflict)
        logger.debug("Sinal já existe na fila (duplicado ignorado): %s", signal_id)
        return None

    def marcar_executado(self, signal_id: str, broker_id: str) -> None:
        """Marca o sinal como executado após a ordem ser enviada ao MT5."""
        try:
            self._supa.table('signals_pending').update({
                'status': STATUS_EXECUTED,
            }).eq('signal_id', signal_id).eq('broker_id', broker_id).execute()
        except Exception as e:
            logger.error("Erro ao marcar sinal executado %s: %s", signal_id, e)

    def marcar_falha(self, signal_id: str, broker_id: str) -> None:
        """Marca o sinal como falho quando a execução na corretora falha."""
        try:
            self._supa.table('signals_pending').update({
                'status': STATUS_FAILED,
            }).eq('signal_id', signal_id).eq('broker_id', broker_id).execute()
        except Exception as e:
            logger.error("Erro ao marcar sinal falho %s: %s", signal_id, e)

    def buscar_pendentes(self, broker_id: str) -> list:
        """
        Retorna sinais pendentes para um broker específico.
        Usado pelo executor de cada corretora para consumir a fila.
        """
        try:
            res = (
                self._supa.table('signals_pending')
                .select('*')
                .eq('broker_id', broker_id)
                .eq('status', STATUS_PENDING)
                .order('created_at', desc=False)
                .execute()
            )
            return res.data or []
        except Exception as e:
            logger.error("Erro ao buscar sinais pendentes para %s: %s", broker_id, e)
            return []

    # ──────────────────────────────────────────────────────────
    # Internos
    # ──────────────────────────────────────────────────────────

    @staticmethod
    def _gerar_signal_id(candle_time: datetime, symbol: str, direction: str) -> str:
        """
        Gera um ID único e determinístico para o sinal.
        Dois processos que detectam o mesmo rompimento no mesmo candle
        produzem o mesmo signal_id → apenas um vai para a fila (deduplicação).
        """
        ts = candle_time.strftime('%Y%m%d_%H%M')
        return f"{ts}_{symbol}_{direction.upper()}"

    def _publicar(
        self,
        signal_id: str,
        broker_id: str,
        symbol: str,
        direction: str,
        candle_time: datetime,
        lot: float,
    ) -> bool:
        """
        Insere o sinal na tabela signals_pending.
        Retorna True se inserido com sucesso, False se já existia (PK conflict).
        """
        try:
            self._supa.table('signals_pending').insert({
                'signal_id':   signal_id,
                'broker_id':   broker_id,
                'symbol':      symbol,
                'direction':   direction.upper(),
                'candle_time': candle_time.isoformat(),
                'lot':         round(lot, 2),
                'status':      STATUS_PENDING,
            }).execute()
            return True
        except Exception as e:
            # PostgREST retorna erro 409 / código '23505' em conflict de PK
            err_str = str(e).lower()
            if '23505' in err_str or 'duplicate' in err_str or '409' in err_str:
                return False  # sinal duplicado — normal, não é erro
            logger.error("Erro ao publicar sinal %s: %s", signal_id, e)
            return False
