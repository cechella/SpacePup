"""
backtest/report.py — Relatório de desempenho do backtest

Calcula e exibe as métricas principais:
  - Win rate, profit factor
  - Drawdown máximo
  - Sharpe ratio
  - Retorno total e por mês
  - Curva de equity (gráfico opcional)
  - CSV detalhado trade-a-trade (exportar_csv_detalhado)
"""

import csv
import logging
import math
import os
import statistics
from datetime import timezone
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
# EXPORTAÇÃO DETALHADA
# ─────────────────────────────────────────────────────────────

def exportar_csv_detalhado(trades: list,
                            caminho: str,
                            config_hash: str = '') -> None:
    """
    Exporta CSV trade-a-trade com todos os campos de análise e condições de entrada.

    Colunas exportadas:
      data_entrada, hora_entrada, dia_semana, sessao
      direcao, entrada, stop, alvo, lote
      rafi, bb_width, bb_abrindo, ma_diff, nivel_sr
      resultado, pnl_usd, pips, r_r_realizado, duracao_min
      capital_antes, capital_apos, motivo_saida, config_hash

    Uso:
      from backtest.report import exportar_csv_detalhado
      exportar_csv_detalhado(trades, 'logs/trades_detalhados.csv', config_hash='a3f9b12c')
    """
    if not trades:
        logger.warning("Nenhum trade para exportar.")
        return

    os.makedirs(os.path.dirname(caminho) if os.path.dirname(caminho) else '.', exist_ok=True)

    SESSOES = [
        # (nome, inicio_h_utc, fim_h_utc) — sessões forex principais
        ('Asia',    0,  8),
        ('Londres', 7, 17),
        ('NY',     12, 22),
    ]

    def _detectar_sessao(hora: int) -> str:
        """Retorna a sessão principal ativa para a hora UTC dada."""
        ativas = [nome for nome, ini, fim in SESSOES if ini <= hora < fim]
        if not ativas:
            return 'Fora'
        # Overlap Londres/NY é o momento de maior liquidez — nomeia explicitamente
        if 'Londres' in ativas and 'NY' in ativas:
            return 'Londres/NY'
        return ativas[-1]

    def _r_r(trade: dict) -> str:
        """R:R realizado = pips variados / risco inicial em pips."""
        risco = trade.get('risco_pips')
        var   = trade.get('variacao_pips')
        if risco and risco > 0 and var is not None:
            return f"{var / risco:.2f}"
        return ''

    fieldnames = [
        'data_entrada', 'hora_entrada', 'dia_semana', 'sessao',
        'direcao', 'entrada', 'stop', 'alvo', 'lote',
        'rafi', 'bb_width', 'bb_abrindo', 'ma_diff', 'nivel_sr',
        'resultado', 'pnl_usd', 'pips', 'r_r_realizado', 'duracao_min',
        'capital_antes', 'capital_apos', 'motivo_saida', 'config_hash',
    ]

    DIAS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sab', 'Dom']

    with open(caminho, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()

        for t in trades:
            ts_ent = t.get('timestamp_entrada')
            try:
                # Normaliza para datetime UTC se necessário
                if hasattr(ts_ent, 'tz_localize'):
                    ts_ent = ts_ent.to_pydatetime()
                if ts_ent and ts_ent.tzinfo is None:
                    ts_ent = ts_ent.replace(tzinfo=timezone.utc)
                hora_utc  = ts_ent.hour if ts_ent else 0
                dia_idx   = ts_ent.weekday() if ts_ent else 0
                data_str  = ts_ent.strftime('%Y-%m-%d') if ts_ent else ''
                hora_str  = ts_ent.strftime('%H:%M') if ts_ent else ''
            except Exception:
                hora_utc  = 0
                dia_idx   = 0
                data_str  = ''
                hora_str  = ''

            pnl      = t.get('pnl_usd', 0)
            resultado = 'WIN' if pnl > 0 else ('LOSS' if pnl < 0 else 'EMPATE')

            writer.writerow({
                'data_entrada'  : data_str,
                'hora_entrada'  : hora_str,
                'dia_semana'    : DIAS[dia_idx],
                'sessao'        : _detectar_sessao(hora_utc),
                'direcao'       : 'BUY' if t.get('sinal') == 'compra' else 'SELL',
                'entrada'       : round(t.get('preco_entrada', 0), 5),
                'stop'          : round(t.get('stop_loss',    0), 5),
                'alvo'          : round(t.get('take_profit',  0), 5),
                'lote'          : t.get('lote', ''),
                'rafi'          : round(t['forca_entrada'], 3) if t.get('forca_entrada') is not None else '',
                'bb_width'      : round(t['bb_width'], 5) if t.get('bb_width') is not None else '',
                'bb_abrindo'    : 'Sim' if t.get('bb_abrindo') else 'Não',
                'ma_diff'       : round(t['ma_diff'], 5) if t.get('ma_diff') is not None else '',
                'nivel_sr'      : round(t['nivel_sr'], 5) if t.get('nivel_sr') is not None else '',
                'resultado'     : resultado,
                'pnl_usd'       : pnl,
                'pips'          : t.get('variacao_pips', ''),
                'r_r_realizado' : _r_r(t),
                'duracao_min'   : (t.get('duracao_candles', 0) or 0) * 5,
                'capital_antes' : t.get('capital_antes', ''),
                'capital_apos'  : t.get('capital_apos', ''),
                'motivo_saida'  : t.get('motivo_saida', ''),
                'config_hash'   : config_hash,
            })

    total  = len(trades)
    wins   = sum(1 for t in trades if t.get('pnl_usd', 0) > 0)
    logger.info(
        f"CSV detalhado exportado: {caminho} | {total} trades | "
        f"WR={wins/total*100:.1f}% | Config: {config_hash or 'n/a'}"
    )


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
