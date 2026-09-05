"""
otimizador_adaptativo.py — Re-otimização automática quando WR/PF cai abaixo da meta

Ativado pelo MonitorPerformance quando:
  WR < 70% OU PF < 2.0 nos últimos 20 trades

Estratégia:
  1. Carrega candles recentes (últimos 6 meses do CSV histórico)
  2. Roda grid search focado (~729 combos — ~10 min) ao redor dos params atuais
  3. Exige WR ≥ 70% E PF ≥ 2.0 no período recente
  4. Escreve os melhores params no Supabase (rafi_bot_config, perfil 'live')
  5. Bot lê automaticamente na próxima iteração

IMPORTANTE: nunca altera parâmetros de risco (risco_por_trade, max_trades, etc.)
Só otimiza os parâmetros de estratégia que o grid search pode validar.
"""

import math
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from itertools import product
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent.parent

# ── Grade adaptativa — focada nos parâmetros validados pelo autoscan ─────────
# 3^6 = 729 combinações → ~10 minutos em CPU moderna
GRADE_ADAPTATIVA = {
    'sr_lookback':           [12, 15, 18],
    'bb_periodo':            [8, 10, 12],
    'ratio_risco_retorno':   [1.2, 1.3, 1.5],
    'autoscan_min_breakout': [0.00004, 0.00005, 0.00007],
    'autoscan_stop_offset':  [0.00008, 0.00010, 0.00015],
    'bb_limiar_estreita':    [0.0014, 0.0016, 0.0018],
}

# Parâmetros fixos durante a otimização (não entram no grid)
PARAMS_FIXOS = {
    'autoscan_min_gap_candles': 8,
    'bb_squeeze_expansao_min':  1.05,
    'bb_desvios':               2.0,
    'bb_periodo_bb':            None,  # usa bb_periodo do grid
}

# Metas obrigatórias (se nenhuma combinação atingir, mantém params atuais)
META_WR_MIN  = 0.68   # ligeiramente abaixo de 70% para ter margem
META_PF_MIN  = 1.80   # ligeiramente abaixo de 2.0 para ter margem

# Período recente usado para re-otimizar (6 meses ≈ 52.560 candles M5)
MESES_RECENTES = 6


def _calcular_bb(candles: list, i: int, periodo: int) -> tuple:
    """Bollinger Bands no candle i usando os 'periodo' candles anteriores."""
    if i < periodo:
        return 0.0, 0.0, 0.0
    closes = [c['close'] for c in candles[i - periodo:i]]
    mid    = sum(closes) / periodo
    var    = sum((x - mid) ** 2 for x in closes) / periodo
    std    = math.sqrt(var) if var > 0 else 0.0
    return mid + 2 * std, mid, mid - 2 * std


def _simular_trade(candles: list, i_entrada: int, direcao: str,
                   entry: float, stop: float, tp: float) -> Optional[int]:
    """
    Simula o desfecho de um trade candle a candle.
    Retorna 1 (win) ou 0 (loss). None se sem dados suficientes.
    """
    for j in range(i_entrada, min(i_entrada + 200, len(candles))):
        c = candles[j]
        if direcao == 'buy':
            if c['low'] <= stop:
                return 0
            if c['high'] >= tp:
                return 1
        else:
            if c['high'] >= stop:
                return 0
            if c['low'] <= tp:
                return 1
    return None   # trade ainda aberto após 200 candles — ignora


def backtest_autoscan(candles: list, params: dict) -> dict:
    """
    Backtest autoscan com os parâmetros fornecidos.

    Retorna dict com: n_trades, wins, wr, profit_factor, score
    """
    sr_lb       = params['sr_lookback']
    bb_per      = params['bb_periodo']
    rr          = params['ratio_risco_retorno']
    min_bk      = params['autoscan_min_breakout']
    stop_off    = params['autoscan_stop_offset']
    squeeze     = params['bb_limiar_estreita']
    min_gap     = 8

    n_needed = sr_lb + bb_per + 2
    if len(candles) < n_needed + 100:
        return {'n_trades': 0, 'wins': 0, 'wr': 0, 'profit_factor': 0, 'score': 0}

    trades     = []
    ultimo_idx = 0

    for i in range(n_needed, len(candles) - 1):
        # Gap mínimo entre sinais
        if i - ultimo_idx < min_gap:
            continue

        # BB candle atual e anterior
        upper_c, mid_c, lower_c = _calcular_bb(candles, i,   bb_per)
        upper_p, mid_p, lower_p = _calcular_bb(candles, i-1, bb_per)

        if mid_c <= 0 or mid_p <= 0:
            continue

        ratio_c = (upper_c - lower_c) / mid_c
        ratio_p = (upper_p - lower_p) / mid_p

        # Filtro 1: squeeze no candle anterior
        if ratio_p >= squeeze:
            continue
        # Filtro 2: expansão no candle atual (≥ 5%)
        if ratio_c <= ratio_p * 1.05:
            continue

        # S/R: janela sem o candle atual (sem lookahead)
        window     = candles[i - sr_lb:i]
        resistance = max(c['high'] for c in window)
        support    = min(c['low']  for c in window)

        c     = candles[i]
        close = c['close']
        open_ = c['open']
        low   = c['low']
        high  = c['high']

        # COMPRA
        if close > resistance and (close - resistance) >= min_bk and close >= open_:
            entry = resistance
            stop  = low - stop_off
            risk  = entry - stop
            if risk <= 0:
                continue
            tp       = entry + risk * rr
            resultado = _simular_trade(candles, i + 1, 'buy', entry, stop, tp)
            if resultado is not None:
                trades.append({'resultado': resultado, 'rr': rr})
                ultimo_idx = i

        # VENDA
        elif close < support and (support - close) >= min_bk and close < open_:
            entry = support
            stop  = high + stop_off
            risk  = stop - entry
            if risk <= 0:
                continue
            tp       = entry - risk * rr
            resultado = _simular_trade(candles, i + 1, 'sell', entry, stop, tp)
            if resultado is not None:
                trades.append({'resultado': resultado, 'rr': rr})
                ultimo_idx = i

    if not trades:
        return {'n_trades': 0, 'wins': 0, 'wr': 0, 'profit_factor': 0, 'score': 0}

    n_trades = len(trades)
    wins     = sum(t['resultado'] for t in trades)
    wr       = wins / n_trades

    ganhos  = sum(t['rr'] for t in trades if t['resultado'] == 1)
    perdas  = sum(1.0    for t in trades if t['resultado'] == 0)
    pf      = ganhos / perdas if perdas > 0 else float('inf')

    # Score: WR × PF — favorece quem atinge as duas metas
    score = wr * min(pf, 5.0)   # cap no PF para não explodir com poucos trades

    return {
        'n_trades':     n_trades,
        'wins':         wins,
        'wr':           round(wr, 4),
        'profit_factor': round(pf, 3),
        'score':        round(score, 4),
    }


def carregar_candles_recentes(csv_path: Optional[str] = None) -> list:
    """
    Carrega os candles M5 dos últimos MESES_RECENTES meses.

    Usa o CSV histórico local (data/EURUSD_M5_8anos.csv) como fonte.
    Se o CSV não existir, retorna lista vazia (otimização será ignorada).
    """
    if csv_path is None:
        csv_path = str(BASE_DIR / 'data' / 'EURUSD_M5_8anos.csv')

    path = Path(csv_path)
    if not path.exists():
        logger.warning(f"[OtimAdaptativo] CSV não encontrado: {path}")
        return []

    try:
        import pandas as pd
        df = pd.read_csv(path, sep='\t', index_col=0, parse_dates=True)

        # Últimos N meses
        corte = datetime.now(tz=timezone.utc) - timedelta(days=MESES_RECENTES * 30)
        if df.index.tz is None:
            df.index = df.index.tz_localize('UTC')
        df = df[df.index >= corte]

        if len(df) < 1000:
            # Poucos dados recentes — usa os últimos 52.560 candles (6 meses aprox.)
            df = pd.read_csv(path, sep='\t', index_col=0, parse_dates=True)
            df = df.tail(52560)

        candles = []
        for ts, row in df.iterrows():
            candles.append({
                'time':  int(ts.timestamp()) if hasattr(ts, 'timestamp') else 0,
                'open':  float(row.iloc[0]),
                'high':  float(row.iloc[1]),
                'low':   float(row.iloc[2]),
                'close': float(row.iloc[3]),
            })

        logger.info(f"[OtimAdaptativo] {len(candles):,} candles recentes carregados")
        return candles

    except Exception as e:
        logger.error(f"[OtimAdaptativo] Erro ao carregar CSV: {e}")
        return []


def otimizar(
    csv_path: Optional[str] = None,
    params_atuais: Optional[dict] = None,
    perfil: str = 'live',
    verbose: bool = True,
) -> Optional[dict]:
    """
    Roda a re-otimização adaptativa.

    Retorna dict com os novos parâmetros se encontrou algo melhor,
    ou None se os parâmetros atuais já são os melhores (ou poucos dados).

    Os novos parâmetros são automaticamente escritos no Supabase.
    """
    logger.info("[OtimAdaptativo] Iniciando re-otimização adaptativa...")

    candles = carregar_candles_recentes(csv_path)
    if len(candles) < 2000:
        logger.warning("[OtimAdaptativo] Dados insuficientes — otimização cancelada")
        return None

    # Gera todas as combinações
    chaves  = list(GRADE_ADAPTATIVA.keys())
    valores = list(GRADE_ADAPTATIVA.values())
    combos  = list(product(*valores))
    total   = len(combos)

    if verbose:
        logger.info(
            f"[OtimAdaptativo] {total} combinações × {len(candles):,} candles "
            f"({MESES_RECENTES} meses recentes)"
        )

    melhor_score  = -1.0
    melhor_params = None
    melhor_stats  = {}

    for idx, vals in enumerate(combos):
        params = dict(zip(chaves, vals))
        stats  = backtest_autoscan(candles, params)

        # Exige mínimo de trades e metas mínimas
        if stats['n_trades'] < 20:
            continue
        if stats['wr'] < META_WR_MIN or stats['profit_factor'] < META_PF_MIN:
            continue

        if stats['score'] > melhor_score:
            melhor_score  = stats['score']
            melhor_params = params.copy()
            melhor_stats  = stats.copy()

        if verbose and (idx + 1) % 100 == 0:
            logger.info(
                f"[OtimAdaptativo] {idx+1}/{total} | "
                f"melhor até agora: WR={melhor_stats.get('wr', 0):.1%} "
                f"PF={melhor_stats.get('profit_factor', 0):.2f}"
            )

    if melhor_params is None:
        logger.warning(
            "[OtimAdaptativo] Nenhuma combinação atingiu WR ≥ 68% e PF ≥ 1.80 "
            "no período recente — mantendo parâmetros atuais."
        )
        return None

    # Verifica se houve melhoria real em relação aos params atuais
    if params_atuais:
        stats_atuais = backtest_autoscan(candles, params_atuais)
        if stats_atuais['score'] >= melhor_score * 0.98:
            logger.info(
                "[OtimAdaptativo] Parâmetros atuais já estão ótimos — sem mudança."
            )
            return None

    logger.info(
        f"[OtimAdaptativo] NOVOS PARÂMETROS ENCONTRADOS\n"
        f"  sr_lookback={melhor_params['sr_lookback']} | "
        f"bb_periodo={melhor_params['bb_periodo']} | "
        f"rr={melhor_params['ratio_risco_retorno']} | "
        f"breakout={melhor_params['autoscan_min_breakout']:.5f} | "
        f"stop={melhor_params['autoscan_stop_offset']:.5f} | "
        f"squeeze={melhor_params['bb_limiar_estreita']:.4f}\n"
        f"  WR={melhor_stats['wr']:.1%} | "
        f"PF={melhor_stats['profit_factor']:.2f} | "
        f"Trades={melhor_stats['n_trades']}"
    )

    # Escreve no Supabase
    _salvar_no_supabase(melhor_params, melhor_stats, perfil)

    return melhor_params


def _salvar_no_supabase(params: dict, stats: dict, perfil: str) -> bool:
    """Persiste os novos parâmetros no Supabase (rafi_bot_config)."""
    try:
        sys.path.insert(0, str(BASE_DIR))
        from src.supabase_sync import salvar_config_supabase
        ok = salvar_config_supabase(params, perfil=perfil, fonte='otimizador_adaptativo')
        if ok:
            logger.info(
                f"[OtimAdaptativo] ✓ Parâmetros salvos no Supabase (perfil={perfil})"
            )
        return ok
    except Exception as e:
        logger.error(f"[OtimAdaptativo] Erro ao salvar no Supabase: {e}")
        return False
