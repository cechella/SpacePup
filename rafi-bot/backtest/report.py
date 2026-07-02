"""
backtest/report.py — Relatório de desempenho do backtest

Calcula e exibe as métricas principais:
  - Win rate, profit factor
  - Drawdown máximo
  - Sharpe ratio
  - Retorno total e por mês
  - Curva de equity (gráfico opcional)
"""

import logging
import math
import statistics
from typing import Optional

logger = logging.getLogger(__name__)

# Matplotlib é opcional — apenas para geração de gráfico
try:
    import matplotlib.pyplot as plt
    import matplotlib.dates as mdates
    MATPLOTLIB_OK = True
except ImportError:
    MATPLOTLIB_OK = False


def gerar_relatorio(trades: list,
                     capital_inicial: float = 20.0,
                     equity_curve: Optional[list] = None,
                     salvar_grafico: Optional[str] = None) -> dict:
    """
    Calcula métricas de desempenho a partir da lista de trades.

    Parâmetros:
      trades          : lista de dicts retornada por Backtest.executar()
      capital_inicial : capital de início do backtest
      equity_curve    : lista de (timestamp, capital) para gráfico
      salvar_grafico  : caminho para salvar gráfico PNG (None = não salva)

    Retorna:
      dict com todas as métricas calculadas
    """
    if not trades:
        logger.warning("Nenhum trade para analisar")
        return {'erro': 'Sem trades'}

    # ── Métricas básicas ───────────────────────────────────────
    total          = len(trades)
    ganhos         = [t for t in trades if t['pnl_usd'] > 0]
    perdas         = [t for t in trades if t['pnl_usd'] < 0]
    empates        = [t for t in trades if t['pnl_usd'] == 0]

    win_rate       = len(ganhos) / total if total > 0 else 0
    total_ganhos   = sum(t['pnl_usd'] for t in ganhos)
    total_perdas   = abs(sum(t['pnl_usd'] for t in perdas))
    profit_factor  = total_ganhos / total_perdas if total_perdas > 0 else float('inf')
    retorno_total  = sum(t['pnl_usd'] for t in trades)
    retorno_pct    = (retorno_total / capital_inicial) * 100

    # ── Médias ────────────────────────────────────────────────
    media_ganho = statistics.mean(t['pnl_usd'] for t in ganhos) if ganhos else 0
    media_perda = abs(statistics.mean(t['pnl_usd'] for t in perdas)) if perdas else 0
    expectancy  = (win_rate * media_ganho) - ((1 - win_rate) * media_perda)

    # ── Média de pips ─────────────────────────────────────────
    pips_ganhos = sum(t['variacao_pips'] for t in ganhos) if ganhos else 0
    pips_perdas = sum(t['variacao_pips'] for t in perdas) if perdas else 0

    # ── Drawdown máximo ───────────────────────────────────────
    max_dd, max_dd_pct = _calcular_drawdown(trades, capital_inicial)

    # ── Sharpe Ratio (simplificado, base diária) ──────────────
    sharpe = _calcular_sharpe(trades)

    # ── Duração média dos trades ──────────────────────────────
    duracoes = [t['duracao_candles'] for t in trades if t['duracao_candles'] > 0]
    duracao_media_min = (statistics.mean(duracoes) * 5) if duracoes else 0

    # ── Análise mensal ────────────────────────────────────────
    por_mes = _resultados_por_mes(trades)

    metricas = {
        # Totais
        'total_trades'       : total,
        'ganhos'             : len(ganhos),
        'perdas'             : len(perdas),
        'empates'            : len(empates),
        # Performance
        'win_rate_pct'       : round(win_rate * 100, 2),
        'profit_factor'      : round(profit_factor, 3),
        'expectancy_usd'     : round(expectancy, 2),
        # Retorno
        'retorno_total_usd'  : round(retorno_total, 2),
        'retorno_pct'        : round(retorno_pct, 2),
        'capital_final'      : round(capital_inicial + retorno_total, 2),
        # Risco
        'drawdown_max_usd'   : round(max_dd, 2),
        'drawdown_max_pct'   : round(max_dd_pct, 2),
        'sharpe_ratio'       : round(sharpe, 3),
        # Médias
        'media_ganho_usd'    : round(media_ganho, 2),
        'media_perda_usd'    : round(media_perda, 2),
        'pips_ganhos_total'  : round(pips_ganhos, 1),
        'pips_perdidos_total': round(abs(pips_perdas), 1),
        'duracao_media_min'  : round(duracao_media_min, 1),
        # Por mês
        'por_mes'            : por_mes,
    }

    # ── Imprimir sumário ──────────────────────────────────────
    _imprimir_sumario(metricas, capital_inicial)

    # ── Gráfico de equity ─────────────────────────────────────
    if salvar_grafico and equity_curve and MATPLOTLIB_OK:
        _plotar_equity(equity_curve, trades, capital_inicial, salvar_grafico)

    return metricas


# ─────────────────────────────────────────────────────────────
# CÁLCULOS AUXILIARES
# ─────────────────────────────────────────────────────────────

def _calcular_drawdown(trades: list, capital_inicial: float) -> tuple[float, float]:
    """
    Calcula o drawdown máximo absoluto e percentual.

    Drawdown: queda do pico até o vale no equity cumulativo.
    """
    capital = capital_inicial
    pico    = capital
    max_dd  = 0.0

    for trade in trades:
        capital += trade['pnl_usd']
        if capital > pico:
            pico = capital
        dd = pico - capital
        if dd > max_dd:
            max_dd = dd

    max_dd_pct = (max_dd / pico * 100) if pico > 0 else 0
    return max_dd, max_dd_pct


def _calcular_sharpe(trades: list, taxa_livre_risco: float = 0.0) -> float:
    """
    Sharpe ratio simplificado usando retornos por trade.

    Taxa livre de risco = 0 (conta demo/pequena sem custo de oportunidade relevante).
    """
    retornos = [t['pnl_usd'] for t in trades]
    if len(retornos) < 2:
        return 0.0

    media = statistics.mean(retornos)
    std   = statistics.stdev(retornos)

    if std == 0:
        return 0.0

    # Anualizar para N trades (assume ~200 trades/ano em M5)
    fator_anual = math.sqrt(200)
    return (media - taxa_livre_risco) / std * fator_anual


def _resultados_por_mes(trades: list) -> dict:
    """Agrupa o P&L por mês (YYYY-MM)."""
    por_mes: dict[str, float] = {}
    for trade in trades:
        ts = trade.get('timestamp_saida')
        if ts is None:
            continue
        try:
            if hasattr(ts, 'strftime'):
                mes = ts.strftime('%Y-%m')
            else:
                mes = str(ts)[:7]
        except Exception:
            mes = 'desconhecido'
        por_mes[mes] = round(por_mes.get(mes, 0.0) + trade['pnl_usd'], 2)
    return dict(sorted(por_mes.items()))


def _imprimir_sumario(m: dict, capital_inicial: float) -> None:
    """Imprime o sumário de desempenho no logger."""
    separador = "=" * 55
    logger.info(separador)
    logger.info("           RELATÓRIO DE BACKTEST — BOT RAFI")
    logger.info(separador)
    logger.info(f"  Total de trades  : {m['total_trades']}")
    logger.info(f"  Ganhos / Perdas  : {m['ganhos']} / {m['perdas']}")
    logger.info(f"  Win Rate         : {m['win_rate_pct']:.1f}%")
    logger.info(f"  Profit Factor    : {m['profit_factor']:.3f}")
    logger.info(f"  Expectativa/trade: ${m['expectancy_usd']:.2f}")
    logger.info(f"  Retorno total    : ${m['retorno_total_usd']:.2f} ({m['retorno_pct']:.1f}%)")
    logger.info(f"  Capital inicial  : ${capital_inicial:.2f}")
    logger.info(f"  Capital final    : ${m['capital_final']:.2f}")
    logger.info(f"  Drawdown máximo  : ${m['drawdown_max_usd']:.2f} ({m['drawdown_max_pct']:.1f}%)")
    logger.info(f"  Sharpe Ratio     : {m['sharpe_ratio']:.3f}")
    logger.info(f"  Duração média    : {m['duracao_media_min']:.0f} min")
    logger.info(separador)

    # Alerta se metas não forem atingidas
    if m['win_rate_pct'] < 55:
        logger.warning(f"  ⚠ Win rate abaixo da meta (55%): {m['win_rate_pct']:.1f}%")
    if m['profit_factor'] < 1.5:
        logger.warning(f"  ⚠ Profit factor abaixo da meta (1.5): {m['profit_factor']:.3f}")
    if m['drawdown_max_pct'] > 20:
        logger.warning(f"  ⚠ Drawdown alto: {m['drawdown_max_pct']:.1f}%")

    if m['por_mes']:
        logger.info("  Resultados por mês:")
        for mes, pnl in m['por_mes'].items():
            sinal = "+" if pnl >= 0 else ""
            logger.info(f"    {mes}: {sinal}${pnl:.2f}")
    logger.info(separador)


def _plotar_equity(equity_curve: list,
                   trades: list,
                   capital_inicial: float,
                   caminho: str) -> None:
    """Gera e salva o gráfico de equity curve com marcadores de trade."""
    if not MATPLOTLIB_OK:
        logger.warning("matplotlib não disponível — gráfico não gerado")
        return

    timestamps = [e[0] for e in equity_curve]
    capitais   = [e[1] for e in equity_curve]

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(14, 8), sharex=False)
    fig.suptitle('Bot RAFI — Backtest Performance', fontsize=14, fontweight='bold')

    # ── Gráfico 1: Equity Curve ────────────────────────────────
    ax1.plot(timestamps, capitais, color='royalblue', linewidth=1.5, label='Capital')
    ax1.axhline(capital_inicial, color='gray', linestyle='--', alpha=0.5, label='Capital inicial')
    ax1.set_ylabel('Capital (USD)')
    ax1.set_title('Curva de Equity')
    ax1.legend(loc='upper left')
    ax1.grid(True, alpha=0.3)

    # Marcar trades positivos e negativos
    for trade in trades:
        ts  = trade.get('timestamp_saida')
        cap = trade.get('capital_apos')
        if ts and cap:
            cor = 'green' if trade['pnl_usd'] >= 0 else 'red'
            ax1.axvline(ts, color=cor, alpha=0.1, linewidth=0.5)

    # ── Gráfico 2: P&L por trade ───────────────────────────────
    pnls = [t['pnl_usd'] for t in trades]
    cores = ['green' if p >= 0 else 'red' for p in pnls]
    indices = list(range(len(pnls)))
    ax2.bar(indices, pnls, color=cores, alpha=0.7, width=0.8)
    ax2.axhline(0, color='black', linewidth=0.8)
    ax2.set_xlabel('Número do Trade')
    ax2.set_ylabel('P&L (USD)')
    ax2.set_title('P&L por Trade')
    ax2.grid(True, alpha=0.3, axis='y')

    plt.tight_layout()
    plt.savefig(caminho, dpi=120, bbox_inches='tight')
    plt.close()
    logger.info(f"Gráfico salvo em: {caminho}")
