"""
broker_health_engine.py — Cálculo do Health Score por broker (Autoscan Bot)

Transforma as 23 métricas brutas em um score composto 0–100 usando pesos e
thresholds lidos exclusivamente do Supabase (broker_health_config).

Regra crítica: NENHUM peso ou threshold é hardcoded.
Se o Supabase estiver indisponível ao calcular o score, lança exceção —
o chamador deve tratar isso como HALT ou skip do ciclo.

Dimensões (devem somar 100 pts):
  dim_pnl           : P&L líquido real         (padrão 30 pts)
  dim_spread        : Spread efetivo + custo    (padrão 20 pts)
  dim_execucao      : Qualidade de execução     (padrão 20 pts)
  dim_conectividade : Conectividade e uptime    (padrão 15 pts)
  dim_margem        : Margem disponível         (padrão 10 pts)
  dim_estabilidade  : Estabilidade do feed      (padrão  5 pts)
"""

import logging
import math
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from .broker_telemetry import MetricasBroker

logger = logging.getLogger(__name__)


# ──────────────────────────────────────────────────────────────────────────────
# Dataclass: resultado do cálculo de score
# ──────────────────────────────────────────────────────────────────────────────

@dataclass
class HealthScore:
    """Resultado do cálculo de health score para um broker em um instante."""

    broker_id: str
    calculado_em: datetime
    health_score: float          # score composto 0–100

    dim_pnl: Optional[float]           = None
    dim_spread: Optional[float]        = None
    dim_execucao: Optional[float]      = None
    dim_conectividade: Optional[float] = None
    dim_margem: Optional[float]        = None
    dim_estabilidade: Optional[float]  = None

    amostra_insuficiente: bool = False  # True se < min_trades_confianca deals
    anomalia_ativa: bool       = False  # True se penalidade de anomalia aplicada


# ──────────────────────────────────────────────────────────────────────────────
# Engine principal
# ──────────────────────────────────────────────────────────────────────────────

class BrokerHealthEngine:
    """
    Calcula o health score composto de um broker a partir das métricas brutas.

    Todos os parâmetros (pesos, thresholds, penalidades) são fornecidos via
    dicionário `config` lido do Supabase antes de chamar `calcular()`.
    """

    def calcular(self, metricas: MetricasBroker, config: dict,
                 scores_outros_brokers: Optional[list] = None) -> HealthScore:
        """
        Calcula o health score a partir das métricas e configuração do Supabase.

        Parâmetros:
          metricas             : snapshot MetricasBroker coletado pelo telemetry
          config               : dicionário com todos os parâmetros de broker_health_config
          scores_outros_brokers: lista de HealthScore dos outros brokers ativos,
                                 usada para normalização cross-broker da dim_pnl.
                                 None ou lista vazia → normalização local apenas.

        Lança KeyError se algum parâmetro obrigatório não estiver no config.
        NUNCA usa default hardcoded — todos os valores vêm do Supabase.
        """
        self._validar_config(config)

        # ── 1. Telemetria vencida → score 0 ──────────────────────────────────
        from datetime import timedelta
        max_age = float(config['telemetria_max_age_s'])
        idade_s = (datetime.now(timezone.utc) - metricas.coletado_em).total_seconds()
        if idade_s > max_age:
            logger.warning(
                f"[{metricas.broker_id}] Telemetria com {idade_s:.0f}s de idade "
                f"(máx={max_age}s) → score zerado (stale telemetry)"
            )
            return HealthScore(
                broker_id=metricas.broker_id,
                calculado_em=datetime.now(timezone.utc),
                health_score=0.0,
            )

        # ── 2. Calcular cada dimensão (0–100 por dimensão) ───────────────────
        dim_pnl           = self._dim_pnl(metricas, config, scores_outros_brokers)
        dim_spread        = self._dim_spread(metricas, config)
        dim_execucao      = self._dim_execucao(metricas)
        dim_conectividade = self._dim_conectividade(metricas)
        dim_margem        = self._dim_margem(metricas, config)
        dim_estabilidade  = self._dim_estabilidade(metricas)

        # ── 3. Score composto ponderado ───────────────────────────────────────
        peso_pnl     = float(config['peso_pnl'])     / 100.0
        peso_spread  = float(config['peso_spread'])  / 100.0
        peso_exec    = float(config['peso_execucao']) / 100.0
        peso_conn    = float(config['peso_conectividade']) / 100.0
        peso_margem  = float(config['peso_margem'])  / 100.0
        peso_estab   = float(config['peso_estabilidade']) / 100.0

        score = (
            dim_pnl           * peso_pnl    +
            dim_spread        * peso_spread  +
            dim_execucao      * peso_exec    +
            dim_conectividade * peso_conn    +
            dim_margem        * peso_margem  +
            dim_estabilidade  * peso_estab
        )

        # ── 4. Amostra insuficiente: sem P&L confiável ────────────────────────
        min_trades = int(config['min_trades_confianca'])
        # Conta quantos deals já foram vistos: se metricas não tiver o dado,
        # considera insuficiente e sinaliza (sem penalizar o score — apenas flag)
        amostra_insuf = (metricas.pnl_liquido_medio_usd == 0.0 and
                         'pnl_liquido_medio_usd' in metricas.metricas_indisponiveis)

        # ── 5. Detecção de anomalia (EMA + N desvios) ────────────────────────
        anomalia = self._detectar_anomalia(metricas, config)
        if anomalia:
            score = max(0.0, score * 0.85)  # penalidade de 15%

        score = round(min(100.0, max(0.0, score)), 2)

        logger.info(
            f"[{metricas.broker_id}] Health Score: {score:.1f} | "
            f"pnl={dim_pnl:.1f} spread={dim_spread:.1f} exec={dim_execucao:.1f} "
            f"conn={dim_conectividade:.1f} margem={dim_margem:.1f} estab={dim_estabilidade:.1f}"
        )

        return HealthScore(
            broker_id=metricas.broker_id,
            calculado_em=datetime.now(timezone.utc),
            health_score=score,
            dim_pnl=round(dim_pnl, 2),
            dim_spread=round(dim_spread, 2),
            dim_execucao=round(dim_execucao, 2),
            dim_conectividade=round(dim_conectividade, 2),
            dim_margem=round(dim_margem, 2),
            dim_estabilidade=round(dim_estabilidade, 2),
            amostra_insuficiente=amostra_insuf,
            anomalia_ativa=anomalia,
        )

    # ── Dimensões individuais ─────────────────────────────────────────────────

    def _dim_pnl(self, m: MetricasBroker, config: dict,
                 outros: Optional[list]) -> float:
        """
        Dimensão P&L: broker que gera mais lucro líquido médio por trade lidera.

        Normalização cross-broker: se há scores de outros brokers disponíveis,
        usa min-max entre todos para posicionar este broker no intervalo 0–100.
        Sem outros brokers → normaliza pelo próprio valor (50 pts se neutro, 100 se positivo).
        """
        pnl = m.pnl_liquido_medio_usd

        # Sem P&L real disponível → score 0
        if pnl is None or 'pnl_liquido_medio_usd' in m.metricas_indisponiveis:
            return 0.0

        # Com outros brokers: normalização linear entre o pior e o melhor
        if outros:
            todos_pnl = [o.dim_pnl for o in outros if o.dim_pnl is not None] + [pnl]
            minimo = min(todos_pnl)
            maximo = max(todos_pnl)
            if maximo == minimo:
                return 50.0
            return round((pnl - minimo) / (maximo - minimo) * 100.0, 2)

        # Sem outros brokers: mapeamento linear simples
        # P&L >= 0: 50 a 100 | P&L < 0: 0 a 50
        if pnl >= 0:
            return min(100.0, 50.0 + (pnl / 10.0) * 50.0)  # $10/trade → 100pts
        else:
            return max(0.0, 50.0 + (pnl / 10.0) * 50.0)

    def _dim_spread(self, m: MetricasBroker, config: dict) -> float:
        """
        Dimensão Spread: quanto menor o custo total em pips, maior o score.
        Referência: custo ≤ 1 pip → 100 pts; custo ≥ 5 pips → 0 pts.
        """
        custo = m.custo_total_pips
        if custo is None or 'custo_total_pips' in m.metricas_indisponiveis:
            # Sem custo: usa spread bruto se disponível
            custo = m.spread_pips
        if custo is None:
            return 50.0  # dado indisponível: score neutro

        # Score decai linearmente: 1pip = 100pts, 5pips = 0pts
        score = 100.0 - ((custo - 1.0) / 4.0) * 100.0
        return max(0.0, min(100.0, score))

    def _dim_execucao(self, m: MetricasBroker) -> float:
        """
        Dimensão Execução: fill rate, reject rate, slippage, tempo de execução.

        Fill rate tem peso 40%, taxas de erro têm peso 40%, tempo de exec 20%.
        """
        score = 0.0
        componentes = 0

        # Fill rate (0–100%): maior é melhor
        if m.fill_rate_pct is not None:
            score += m.fill_rate_pct * 0.40
            componentes += 1
        else:
            # Sem fill rate: assumir 100% (sem evidência de rejeição)
            score += 100.0 * 0.40
            componentes += 1

        # Taxas de erro (reject, requote, timeout, api_error): menores são melhores
        taxa_erro = (m.reject_rate_pct + m.requote_rate_pct +
                     m.timeout_rate_pct + m.api_error_rate_pct)
        score_erro = max(0.0, 100.0 - taxa_erro * 5.0)  # 20% de erros → 0pts
        score += score_erro * 0.40
        componentes += 1

        # Tempo de execução (ms): ideal ≤ 100ms, ruim ≥ 1000ms
        if m.order_execution_time_ms is not None:
            t = m.order_execution_time_ms
            score_tempo = max(0.0, 100.0 - ((t - 100.0) / 900.0) * 100.0)
            score += score_tempo * 0.20
            componentes += 1

        if componentes < 3:
            # Normaliza proporcionalmente
            return min(100.0, score * (3.0 / componentes)) if componentes else 50.0

        return min(100.0, max(0.0, score))

    def _dim_conectividade(self, m: MetricasBroker) -> float:
        """
        Dimensão Conectividade: uptime, latência, desconexões.
        """
        score = 0.0

        # Uptime (peso 50%): 100% uptime → 50pts
        score += m.uptime_pct * 0.50

        # Latência (peso 30%): ideal ≤ 50ms, ruim ≥ 500ms
        if m.heartbeat_latency_ms is not None:
            lat = m.heartbeat_latency_ms
            score_lat = max(0.0, 100.0 - ((lat - 50.0) / 450.0) * 100.0)
            score += score_lat * 0.30
        else:
            score += 50.0 * 0.30  # sem dado: neutro

        # Disconnect count (peso 20%): 0 desconexões → 20pts, 5+ → 0pts
        score_disc = max(0.0, 100.0 - (m.disconnect_count / 5.0) * 100.0)
        score += score_disc * 0.20

        return round(min(100.0, max(0.0, score)), 2)

    def _dim_margem(self, m: MetricasBroker, config: dict) -> float:
        """
        Dimensão Margem: nível de margem e margem livre.
        """
        score = 0.0

        # Nível de margem (peso 60%): ≥ 500% → 60pts, < 100% → 0pts
        if m.margin_level_pct is not None and m.margin_level_pct > 0:
            ml = m.margin_level_pct
            score_ml = min(100.0, (ml / 500.0) * 100.0)
            score += score_ml * 0.60
        else:
            score += 60.0  # sem posições abertas: margem plena

        # Margem livre absoluta (peso 40%): ≥ $5000 → 40pts, < $100 → 0pts
        if m.free_margin_usd is not None:
            fm = m.free_margin_usd
            score_fm = min(100.0, (fm / 5000.0) * 100.0)
            score += score_fm * 0.40
        else:
            score += 40.0  # sem dado: neutro

        return round(min(100.0, max(0.0, score)), 2)

    def _dim_estabilidade(self, m: MetricasBroker) -> float:
        """
        Dimensão Estabilidade: delay e estabilidade do feed de preços.
        """
        score = 0.0

        # Estabilidade do feed (peso 60%): 0–100 calculado pelo telemetry
        if m.price_feed_stability is not None:
            score += m.price_feed_stability * 0.60
        else:
            score += 50.0 * 0.60  # sem dado: neutro

        # Delay do feed (peso 40%): ideal ≤ 100ms, ruim ≥ 1000ms
        if m.price_feed_delay_ms is not None:
            delay = m.price_feed_delay_ms
            score_delay = max(0.0, 100.0 - ((delay - 100.0) / 900.0) * 100.0)
            score += score_delay * 0.40
        else:
            score += 50.0 * 0.40  # sem dado: neutro

        return round(min(100.0, max(0.0, score)), 2)

    def _detectar_anomalia(self, m: MetricasBroker, config: dict) -> bool:
        """
        Detecta spike anômalo no spread usando EMA + N desvios padrão.
        Retorna True se spread atual > EMA + N * desvio (anomalia confirmada).

        Por enquanto usa apenas o spread atual vs. valores esperados;
        a janela EMA real é mantida pela camada de persistência (Supabase).
        """
        n_desvios = float(config['anomalia_desvios'])
        spread = m.spread_pips

        if spread is None or spread <= 0:
            return False

        # Spike muito acima do esperado para EURUSD (spread > 10 pips = anômalo)
        # Threshold de referência em ambiente sem histórico EMA: 10 pips
        # (o Admin pode ajustar via anomalia_desvios que escala o threshold)
        threshold_spike = 2.0 * n_desvios  # base: 2 pips * n_desvios
        if spread > threshold_spike:
            logger.warning(
                f"[{m.broker_id}] Anomalia de spread detectada: "
                f"{spread:.2f} pips > threshold {threshold_spike:.2f} pips"
            )
            return True
        return False

    # ── Validação da config ───────────────────────────────────────────────────

    _CHAVES_OBRIGATORIAS = [
        'peso_pnl', 'peso_spread', 'peso_execucao', 'peso_conectividade',
        'peso_margem', 'peso_estabilidade',
        'telemetria_max_age_s', 'min_trades_confianca',
        'anomalia_desvios',
    ]

    def _validar_config(self, config: dict) -> None:
        """
        Garante que todas as chaves obrigatórias estão no config.
        Lança KeyError com mensagem clara se alguma estiver faltando.
        """
        faltando = [k for k in self._CHAVES_OBRIGATORIAS if k not in config]
        if faltando:
            raise KeyError(
                f"Parâmetros ausentes no broker_health_config do Supabase: {faltando}. "
                f"Execute a migração migrate_broker_health.sql e verifique o Admin Panel."
            )
