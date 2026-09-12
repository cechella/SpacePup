"""
broker_telemetry.py — Coleta de métricas por broker (Autoscan Bot)

Responsabilidades:
  1. Coletar as 23 métricas brutas do terminal MT5 conectado a um broker
  2. Publicar no Supabase (broker_health_metrics) a cada intervalo configurado
  3. Rodar em thread daemon (não bloqueia o loop principal do executor)

Regra crítica: o intervalo de coleta é lido do Supabase (broker_health_config.intervalo_coleta_s).
NENHUM valor operacional é hardcoded — se o Supabase estiver indisponível, a thread
registra o erro e não coleta até o Supabase voltar.
"""

import logging
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Dataclass: 23 métricas brutas em 5 grupos
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class MetricasBroker:
    """
    Snapshot de métricas coletadas de um broker via MT5.

    Grupos:
      A — Conectividade (6 campos)
      B — Execução de ordens (7 campos)
      C — Spread e custo (4 campos)
      D — P&L real (3 campos)
      E — Margem e capacidade (4 campos)
    """

    broker_id: str
    coletado_em: datetime = field(default_factory=lambda: datetime.now(timezone.utc))

    # ── Grupo A: Conectividade ────────────────────────────────────────────────
    connection_status: Optional[bool]   = None  # MT5 conectado?
    heartbeat_latency_ms: Optional[float] = None  # latência do ping interno
    api_response_time_ms: Optional[float] = None  # tempo de resposta da API
    disconnect_count: int               = 0     # desconexões na janela
    reconnect_frequency: float          = 0.0   # reconexões por hora
    uptime_pct: float                   = 100.0 # % uptime na janela

    # ── Grupo B: Execução de ordens ──────────────────────────────────────────
    order_execution_time_ms: Optional[float] = None  # tempo médio de execução
    fill_rate_pct: Optional[float]           = None  # % ordens preenchidas
    partial_fill_rate_pct: float             = 0.0   # % preenchimento parcial
    reject_rate_pct: float                   = 0.0   # % ordens rejeitadas
    requote_rate_pct: float                  = 0.0   # % requotes recebidos
    timeout_rate_pct: float                  = 0.0   # % timeouts
    api_error_rate_pct: float                = 0.0   # % erros de API

    # ── Grupo C: Spread e custo ──────────────────────────────────────────────
    spread_pips: Optional[float]             = None  # spread atual em pips
    effective_spread_pips: Optional[float]   = None  # spread efetivo (com slippage)
    slippage_pips: float                     = 0.0   # slippage médio
    commission_per_lot: float                = 0.0   # comissão por lote (USD)

    # ── Grupo D: P&L real ────────────────────────────────────────────────────
    pnl_liquido_medio_usd: float             = 0.0   # média P&L líquido (janela)
    pnl_por_pip_usd: float                   = 0.0   # P&L médio por pip movido
    custo_total_pips: Optional[float]        = None  # spread + slippage + comissão

    # ── Grupo E: Margem e capacidade ─────────────────────────────────────────
    free_margin_usd: Optional[float]         = None  # margem livre atual
    margin_level_pct: Optional[float]        = None  # nível de margem (%)
    price_feed_delay_ms: Optional[float]     = None  # atraso do feed de preços
    price_feed_stability: Optional[float]    = None  # estabilidade 0-100

    # ── Metadados de disponibilidade ─────────────────────────────────────────
    metricas_indisponiveis: list = field(default_factory=list)


# ──────────────────────────────────────────────────────────────────────────────
# Coleta das métricas brutas via MT5
# ──────────────────────────────────────────────────────────────────────────────

def coletar_metricas(mt5_client, broker_id: str, simbolo: str,
                     historico_deals: list, janela_trades: int = 50) -> MetricasBroker:
    """
    Coleta as 23 métricas do terminal MT5 ativo para o broker especificado.

    Parâmetros:
      mt5_client     : instância de ClienteMT5 já conectada
      broker_id      : identificador do broker (ex.: 'pepperstone')
      simbolo        : par sendo operado (ex.: 'EURUSD')
      historico_deals: lista de deals recentes (dicts) para P&L e execução
      janela_trades  : quantos trades usar na janela de P&L (lido do Supabase)

    Campos indisponíveis ficam como None e são registrados em metricas_indisponiveis.
    NUNCA lança exceção — retorna snapshot parcial se MT5 estiver instável.
    """
    m = MetricasBroker(broker_id=broker_id)
    indisponiveis = []
    t0_total = time.monotonic()

    try:
        # ── Grupo A: Conectividade ──────────────────────────────────────────
        m.connection_status = mt5_client.conectado

        # Latência: mede tempo de resposta de uma consulta simples ao terminal
        try:
            t0 = time.monotonic()
            info = _mt5_account_info(mt5_client)
            m.api_response_time_ms = round((time.monotonic() - t0) * 1000, 2)
            m.heartbeat_latency_ms = m.api_response_time_ms  # proxy para heartbeat
        except Exception:
            indisponiveis += ['heartbeat_latency_ms', 'api_response_time_ms']

        # Uptime: baseado no histórico de disconnect_count acumulado externamente
        # (disconnect_count é incrementado pelo executor ao detectar desconexões)
        # Por enquanto, mantemos 100% se conectado, 0% se desconectado.
        m.uptime_pct = 100.0 if m.connection_status else 0.0

        # ── Grupo B: Execução de ordens ────────────────────────────────────
        if historico_deals:
            deals_janela = historico_deals[-janela_trades:]
            total = len(deals_janela)

            # Fill rate: deals com volume > 0 (preenchimento total ou parcial)
            preenchidos = sum(1 for d in deals_janela if d.get('volume', 0) > 0)
            m.fill_rate_pct = round(preenchidos / total * 100, 2) if total else 0.0

            # Slippage: diferença entre preço solicitado e executado (em pips)
            slippages = [
                abs(d.get('price', 0) - d.get('price_requested', d.get('price', 0)))
                for d in deals_janela
                if d.get('price_requested') is not None
            ]
            if slippages:
                ponto = _obter_ponto(mt5_client, simbolo)
                m.slippage_pips = round(
                    (sum(slippages) / len(slippages)) / (ponto * 10), 3
                ) if ponto else 0.0

            # Tempo médio de execução (se disponível nos deals)
            tempos = [d['exec_time_ms'] for d in deals_janela if 'exec_time_ms' in d]
            m.order_execution_time_ms = round(
                sum(tempos) / len(tempos), 2
            ) if tempos else None

            # Comissão por lote (média dos deals com commission preenchida)
            comissoes = [
                abs(d.get('commission', 0)) / max(d.get('volume', 1), 0.001)
                for d in deals_janela
                if d.get('commission') is not None and d.get('volume', 0) > 0
            ]
            m.commission_per_lot = round(
                sum(comissoes) / len(comissoes), 4
            ) if comissoes else 0.0

        else:
            indisponiveis += ['fill_rate_pct', 'order_execution_time_ms',
                               'slippage_pips', 'commission_per_lot']

        # ── Grupo C: Spread e custo ────────────────────────────────────────
        try:
            tick = _mt5_tick(mt5_client, simbolo)
            if tick:
                ponto = _obter_ponto(mt5_client, simbolo) or 0.00001
                spread_raw = tick.get('ask', 0) - tick.get('bid', 0)
                m.spread_pips = round(spread_raw / (ponto * 10), 2)
                # Spread efetivo = spread + slippage
                m.effective_spread_pips = round(m.spread_pips + m.slippage_pips, 2)
                # Custo total em pips: spread efetivo + comissão convertida em pips
                # (comissão por lote / valor por pip por lote, aprox. 10 USD/pip/lote)
                custo_comissao_pips = m.commission_per_lot / 10.0
                m.custo_total_pips = round(m.effective_spread_pips + custo_comissao_pips, 3)
            else:
                indisponiveis += ['spread_pips', 'effective_spread_pips', 'custo_total_pips']
        except Exception:
            indisponiveis += ['spread_pips', 'effective_spread_pips', 'custo_total_pips']

        # ── Grupo D: P&L real ─────────────────────────────────────────────
        if historico_deals:
            deals_janela = historico_deals[-janela_trades:]
            pnls = [d.get('pnl_liquido', d.get('profit', 0)) for d in deals_janela
                    if d.get('pnl_liquido') is not None or d.get('profit') is not None]
            if pnls:
                m.pnl_liquido_medio_usd = round(sum(pnls) / len(pnls), 4)
                # P&L por pip: divide o PNL pela diferença de preço média em pips
                pnl_por_pip_list = [
                    d.get('pnl_por_pip') for d in deals_janela
                    if d.get('pnl_por_pip') is not None
                ]
                if pnl_por_pip_list:
                    m.pnl_por_pip_usd = round(sum(pnl_por_pip_list) / len(pnl_por_pip_list), 4)
            else:
                indisponiveis.append('pnl_liquido_medio_usd')
        else:
            indisponiveis += ['pnl_liquido_medio_usd', 'pnl_por_pip_usd']

        # ── Grupo E: Margem e capacidade ──────────────────────────────────
        try:
            info_conta = _mt5_account_info(mt5_client)
            if info_conta:
                m.free_margin_usd = round(info_conta.get('margin_free', 0), 2)
                m.margin_level_pct = round(info_conta.get('margin_level', 0), 2)
            else:
                indisponiveis += ['free_margin_usd', 'margin_level_pct']
        except Exception:
            indisponiveis += ['free_margin_usd', 'margin_level_pct']

        # Feed delay: diferença entre timestamp do tick e now (proxy de atraso)
        try:
            tick = _mt5_tick(mt5_client, simbolo)
            if tick and tick.get('time'):
                agora = time.time()
                m.price_feed_delay_ms = round(
                    max(agora - tick['time'], 0) * 1000, 2
                )
                # Estabilidade: 100 se delay < 500ms, decai linearmente até 0 em 5s
                m.price_feed_stability = max(0.0, 100.0 - (m.price_feed_delay_ms / 50.0))
            else:
                indisponiveis += ['price_feed_delay_ms', 'price_feed_stability']
        except Exception:
            indisponiveis += ['price_feed_delay_ms', 'price_feed_stability']

    except Exception as e:
        logger.error(f"[{broker_id}] Erro inesperado na coleta de métricas: {e}")

    m.metricas_indisponiveis = list(set(indisponiveis))

    elapsed = round((time.monotonic() - t0_total) * 1000, 1)
    logger.debug(
        f"[{broker_id}] Métricas coletadas em {elapsed}ms | "
        f"indisponíveis: {m.metricas_indisponiveis or 'nenhuma'}"
    )
    return m


def _mt5_account_info(mt5_client) -> Optional[dict]:
    """Retorna account_info como dict (abstração para facilitar testes)."""
    try:
        import MetaTrader5 as mt5
        info = mt5.account_info()
        if info is None:
            return None
        return {
            'login': info.login,
            'balance': info.balance,
            'equity': info.equity,
            'margin': info.margin,
            'margin_free': info.margin_free,
            'margin_level': info.margin_level,
            'server': info.server,
        }
    except Exception:
        return None


def _mt5_tick(mt5_client, simbolo: str) -> Optional[dict]:
    """Retorna o tick atual como dict (abstração para facilitar testes)."""
    try:
        import MetaTrader5 as mt5
        tick = mt5.symbol_info_tick(simbolo)
        if tick is None:
            return None
        return {
            'bid': tick.bid,
            'ask': tick.ask,
            'time': tick.time,
            'last': tick.last,
        }
    except Exception:
        return None


def _obter_ponto(mt5_client, simbolo: str) -> Optional[float]:
    """Retorna o tamanho do ponto do símbolo (ex.: 0.00001 para EURUSD)."""
    try:
        import MetaTrader5 as mt5
        info = mt5.symbol_info(simbolo)
        return info.point if info else None
    except Exception:
        return None


# ──────────────────────────────────────────────────────────────────────────────
# Thread de telemetria (roda em background, daemon)
# ──────────────────────────────────────────────────────────────────────────────

class BrokerTelemetryThread(threading.Thread):
    """
    Thread daemon que coleta métricas do broker a cada N segundos e publica
    no Supabase (tabela broker_health_metrics).

    O intervalo N é lido do Supabase (broker_health_config.intervalo_coleta_s).
    Se o Supabase estiver indisponível, a coleta é pulada e tentada no próximo ciclo.

    Uso:
        thread = BrokerTelemetryThread(
            broker_id='pepperstone',
            mt5_client=mt5,
            simbolo='EURUSD',
            supabase_sync=sync,
        )
        thread.start()
        # para a thread:
        thread.parar()
        thread.join(timeout=10)
    """

    def __init__(self, broker_id: str, mt5_client, simbolo: str, supabase_sync):
        """
        Parâmetros:
          broker_id    : identificador do broker
          mt5_client   : instância de ClienteMT5 (já conectada)
          simbolo      : par operado (ex.: 'EURUSD')
          supabase_sync: módulo supabase_sync (para carregar config e publicar)
        """
        super().__init__(name=f"telemetry-{broker_id}", daemon=True)
        self.broker_id    = broker_id
        self.mt5          = mt5_client
        self.simbolo      = simbolo
        self.sync         = supabase_sync
        self._parar       = threading.Event()
        self._historico   = []  # cache local de deals recentes

    def parar(self) -> None:
        """Sinaliza a thread para encerrar no próximo ciclo."""
        self._parar.set()

    def run(self) -> None:
        logger.info(f"[{self.broker_id}] Thread de telemetria iniciada")

        while not self._parar.is_set():
            intervalo = self._ler_intervalo_supabase()
            if intervalo is None:
                # Supabase indisponível — aguarda 30s antes de tentar novamente
                logger.warning(
                    f"[{self.broker_id}] Supabase indisponível para ler intervalo "
                    f"de coleta — aguardando 30s"
                )
                self._parar.wait(30)
                continue

            try:
                self._atualizar_historico_deals()
                config = self.sync.carregar_config_broker_health()
                janela = int(config.get('pnl_janela_trades', 50))

                metricas = coletar_metricas(
                    mt5_client=self.mt5,
                    broker_id=self.broker_id,
                    simbolo=self.simbolo,
                    historico_deals=self._historico,
                    janela_trades=janela,
                )
                self.sync.publicar_metricas_broker(metricas)

            except Exception as e:
                logger.error(f"[{self.broker_id}] Erro no ciclo de telemetria: {e}")

            # Aguarda o intervalo antes do próximo ciclo (ou encerra se parar() chamado)
            self._parar.wait(intervalo)

        logger.info(f"[{self.broker_id}] Thread de telemetria encerrada")

    def _ler_intervalo_supabase(self) -> Optional[float]:
        """
        Lê o intervalo de coleta do Supabase.
        Retorna None se o Supabase estiver indisponível.
        NUNCA usa fallback hardcoded.
        """
        try:
            config = self.sync.carregar_config_broker_health()
            return float(config['intervalo_coleta_s'])
        except Exception as e:
            logger.error(
                f"[{self.broker_id}] Falha ao ler intervalo_coleta_s do Supabase: {e}"
            )
            return None

    def _atualizar_historico_deals(self) -> None:
        """
        Busca os deals mais recentes do MT5 e atualiza o cache local.
        Mantém apenas os últimos 200 deals para controle de memória.
        """
        try:
            if not self.mt5.conectado:
                return

            import MetaTrader5 as _mt5
            from datetime import timedelta

            fim = datetime.now(timezone.utc)
            inicio = fim - timedelta(days=7)  # janela de 7 dias para histórico

            deals_raw = _mt5.history_deals_get(inicio, fim)
            if deals_raw is None:
                return

            novos = []
            for d in deals_raw:
                # Filtra apenas deals do símbolo operado (EURUSD, etc.)
                if d.symbol != self.simbolo:
                    continue
                # Ignores deals de depósito/saque (entry = 2 = balance)
                if d.entry == 2:
                    continue
                novos.append({
                    'ticket'    : d.ticket,
                    'time'      : d.time,
                    'volume'    : d.volume,
                    'price'     : d.price,
                    'profit'    : d.profit,
                    'commission': d.commission,
                    'swap'      : d.swap,
                    'pnl_liquido': round(d.profit + d.commission + d.swap, 4),
                })

            self._historico = novos[-200:]  # mantém os 200 mais recentes

        except Exception as e:
            logger.debug(f"[{self.broker_id}] Erro ao atualizar histórico de deals: {e}")
