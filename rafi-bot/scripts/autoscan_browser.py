"""
autoscan_browser.py — Replica EXATA do Autoscan do browser (indicators.ts + page.tsx)

Algoritmo idêntico ao browser:
  1. Gera os mesmos candles demo (seed 1337) via scripts/gerar_demo_data.py
  2. Calcula BB com desvio padrão populacional (÷N), período 8
  3. Escaneia TODOS os candles de uma vez procurando:
       - squeeze (prevRatio < squeezeRatio=0.0012) expandindo (currRatio > prevRatio*1.05)
       - fechamento acima da resistência (max HIGH dos 20 candles anteriores) → COMPRA
       - fechamento abaixo do suporte  (min LOW  dos 20 candles anteriores) → VENDA
  4. Para cada sinal: olha para frente e determina WIN/LOSS
  5. Aplica tabela de lotes composta (igual ao getLotForCapital do browser)

Uso:
  python scripts/autoscan_browser.py
  python scripts/autoscan_browser.py --csv data/qualquer.csv
"""

import math
import argparse
import sys
import os
import pandas as pd

# Permite importar gerar_demo_data do mesmo diretório de scripts
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from gerar_demo_data import gerar_demo_m5


# ── Tabela de lotes (réplica de SCALE_TIERS em lot-scaling.ts) ───────────────

SCALE_TIERS = [
    (0,       0.10),
    (40,      0.20),
    (80,      0.40),
    (150,     0.70),
    (200,     1.00),
    (400,     2.00),
    (800,     4.00),
    (1_500,   8.00),
    (3_000,  15.00),
    (6_000,  30.00),
    (10_000, 50.00),
    (20_000,100.00),
]

def get_lot(capital: float) -> float:
    """getLotForCapital() do browser."""
    lot = SCALE_TIERS[0][1]
    for min_cap, l in SCALE_TIERS:
        if capital >= min_cap:
            lot = l
    return lot


# ── Bollinger Bands — população (÷N), igual ao browser ───────────────────────

def calc_bollinger(closes: list[float], period: int = 8) -> list[dict]:
    """
    Réplica de calcBollingerBands() do indicators.ts.
    Usa desvio padrão POPULACIONAL (÷N), não amostral.
    Retorna lista de {upper, middle, lower, width, mid, idx}.
    """
    result = []
    for i in range(period - 1, len(closes)):
        window = closes[i - period + 1: i + 1]
        mean   = sum(window) / period
        var    = sum((v - mean) ** 2 for v in window) / period
        std    = math.sqrt(var)
        result.append({
            'idx'   : i,
            'upper' : mean + 2 * std,
            'middle': mean,
            'lower' : mean - 2 * std,
            'width' : 4 * std,
            'mid'   : mean,
        })
    return result


# ── AutoScan — réplica de autoScanBreakouts() de indicators.ts ───────────────

def autoscan_breakouts(candles: list[dict],
                       sr_lookback:    int   = 20,
                       bb_period:      int   = 8,
                       rr_ratio:       float = 1.5,
                       min_breakout:   float = 0.00003,
                       min_gap:        int   = 8,
                       squeeze_ratio:  float = 0.0012,
                       expansao_min:   float = 1.05,
                       stop_offset:    float = 0.00015) -> list[dict]:
    """
    Réplica exata de autoScanBreakouts() do browser (indicators.ts).

    Critérios de sinal:
      - BB squeeze no candle anterior (prevRatio < squeezeRatio)
      - BB expandindo no candle atual (currRatio > prevRatio * 1.05)
      - COMPRA: close > max_high(últimos sr_lookback) e close > open (candle verde)
      - VENDA:  close < min_low(últimos sr_lookback) e close < open (candle vermelho)
    """
    closes = [c['close'] for c in candles]
    bb_list = calc_bollinger(closes, bb_period)

    # Mapa timestamp → BB (índice global de candle)
    bb_by_idx = {}
    for bb in bb_list:
        bb_by_idx[bb['idx']] = bb

    trades   = []
    last_idx = -min_gap

    start = sr_lookback + bb_period
    for i in range(start, len(candles)):
        if i - last_idx < min_gap:
            continue

        c    = candles[i]
        prev = candles[i - 1]

        bb_curr = bb_by_idx.get(i)
        bb_prev = bb_by_idx.get(i - 1)
        if not bb_curr or not bb_prev:
            continue

        # BB squeeze → expansão
        prev_ratio = bb_prev['width'] / bb_prev['mid']
        curr_ratio = bb_curr['width'] / bb_curr['mid']
        if prev_ratio >= squeeze_ratio:                  # não era squeeze
            continue
        if curr_ratio <= prev_ratio * expansao_min:      # não está expandindo
            continue

        # S/R = max HIGH / min LOW dos candles anteriores (sem lookahead)
        window     = candles[i - sr_lookback: i]
        resistance = max(w['high'] for w in window)
        support    = min(w['low']  for w in window)

        def p5(v): return round(v * 100000) / 100000

        # COMPRA: fecha acima da resistência, candle verde
        if c['close'] > resistance and c['close'] - resistance >= min_breakout and c['close'] >= c['open']:
            entry  = p5(resistance)
            stop   = p5(c['low'] - stop_offset)
            risk   = entry - stop
            trades.append({
                'time'      : c['time'],
                'direction' : 'buy',
                'entry'     : entry,
                'stop_loss' : stop,
                'take_profit': p5(entry + risk * rr_ratio),
                'candle_idx': i,
            })
            last_idx = i

        # VENDA: fecha abaixo do suporte, candle vermelho
        elif c['close'] < support and support - c['close'] >= min_breakout and c['close'] < c['open']:
            entry  = p5(support)
            stop   = p5(c['high'] + stop_offset)
            risk   = stop - entry
            trades.append({
                'time'      : c['time'],
                'direction' : 'sell',
                'entry'     : entry,
                'stop_loss' : stop,
                'take_profit': p5(entry - risk * rr_ratio),
                'candle_idx': i,
            })
            last_idx = i

    return trades


# ── Avaliação WIN/LOSS (réplica de handleAutoScan em page.tsx) ────────────────

def avaliar_resultado(signal: dict, candles: list[dict]) -> str:
    """
    Réplica do loop de avaliação do browser (page.tsx linhas 231-242):
      for j in range(entryIdx + 1, len(candles)):
        if buy:  low <= SL → LOSS; high >= TP → WIN
        if sell: high >= SL → LOSS; low <= TP → WIN
    """
    entry_idx = signal['candle_idx']
    direction = signal['direction']
    sl = signal['stop_loss']
    tp = signal['take_profit']

    for j in range(entry_idx + 1, len(candles)):
        c = candles[j]
        if direction == 'buy':
            if c['low']  <= sl: return 'loss'
            if c['high'] >= tp: return 'win'
        else:
            if c['high'] >= sl: return 'loss'
            if c['low']  <= tp: return 'win'
    return 'pending'


# ── Cálculo de P&L por trade (réplica de handleAutoScan + calcCapital) ────────

def calc_pnl(signal: dict, result: str, lot: float) -> float:
    """
    Réplica do cálculo de P&L do browser (page.tsx linhas 245-255):
      pips = (tp - entry) * 10000   para compra
      capital += pips * lot * 10    para WIN
      pips = (entry - sl) * 10000   para perda (sempre positivo)
      capital -= pips * lot * 10    para LOSS
    """
    if result == 'win':
        if signal['direction'] == 'buy':
            pips = (signal['take_profit'] - signal['entry']) * 10000
        else:
            pips = (signal['entry'] - signal['take_profit']) * 10000
        return round(pips * lot * 10, 2)
    elif result == 'loss':
        if signal['direction'] == 'buy':
            pips = (signal['entry'] - signal['stop_loss']) * 10000
        else:
            pips = (signal['stop_loss'] - signal['entry']) * 10000
        return -round(pips * lot * 10, 2)
    return 0.0


# ── Ponto de entrada ──────────────────────────────────────────────────────────

def carregar_params_supabase() -> dict:
    """
    Lê os parâmetros do perfil 'simulator' na tabela rafi_bot_config.
    Retorna dict com os valores ou {} se Supabase não estiver disponível.
    """
    try:
        from supabase import create_client
        import os
        from pathlib import Path

        # Carrega .env se existir (rafi-bot/.env)
        env_path = Path(__file__).parent.parent / '.env'
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                if '=' in line and not line.startswith('#'):
                    k, v = line.split('=', 1)
                    os.environ.setdefault(k.strip(), v.strip())

        url = os.getenv('SUPABASE_URL', '')
        key = os.getenv('SUPABASE_KEY', '')
        if not url or not key or 'xxxx' in url:
            return {}

        supa = create_client(url, key)
        resp = supa.table('rafi_bot_config').select('*').eq('profile', 'simulator').limit(1).execute()
        if resp.data:
            return resp.data[0]
    except Exception as e:
        print(f"[Supabase] indisponível — usando defaults hardcoded ({e})")
    return {}


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Autoscan browser — réplica exata do indicators.ts'
    )
    parser.add_argument('--csv', default=None,
                        help='CSV com dados históricos (padrão: dados demo seed 1337)')
    parser.add_argument('--capital', type=float, default=100.0,
                        help='Capital inicial em USD (padrão: 100)')
    args = parser.parse_args()

    # ── Parâmetros do Supabase (perfil simulator) ou defaults hardcoded ─────
    supa_cfg = carregar_params_supabase()
    sr_lookback   = int(supa_cfg.get('sr_lookback',               20))
    bb_period     = int(supa_cfg.get('bb_periodo',                8))
    rr_ratio      = float(supa_cfg.get('ratio_risco_retorno',     1.5))
    min_breakout  = float(supa_cfg.get('autoscan_min_breakout',   0.00003))
    min_gap       = int(supa_cfg.get('autoscan_min_gap_candles',  8))
    squeeze_ratio = float(supa_cfg.get('bb_limiar_estreita',      0.0012))
    stop_offset   = float(supa_cfg.get('autoscan_stop_offset',    0.00015))
    expansao_min  = float(supa_cfg.get('bb_squeeze_expansao_min', 1.05))

    fonte_params = 'Supabase (perfil simulator)' if supa_cfg else 'defaults hardcoded'

    # ── Carregar candles ────────────────────────────────────────────────────
    if args.csv:
        df = pd.read_csv(args.csv, index_col=0, parse_dates=True)
        candles = [
            {'time': int(row.Index.timestamp()), 'open': row.open,
             'high': row.high, 'low': row.low, 'close': row.close}
            for row in df.itertuples()
        ]
        fonte = args.csv
    else:
        df = gerar_demo_m5()
        candles = [
            {'time': int(ts.timestamp()), 'open': row.open,
             'high': row.high, 'low': row.low, 'close': row.close}
            for ts, row in df.iterrows()
        ]
        fonte = 'demo (seed 1337, Jan 6-10 2025)'

    print(f"\n=== AUTOSCAN BROWSER — réplica Python ===")
    print(f"Dados       : {fonte} | {len(candles)} candles")
    print(f"Parâmetros  : {fonte_params}")
    print(f"  sr_lookback={sr_lookback} | bb_period={bb_period} | rr={rr_ratio}")
    print(f"  min_breakout={min_breakout} | min_gap={min_gap} | squeeze={squeeze_ratio}")
    print(f"  stop_offset={stop_offset} | expansao_min={expansao_min}")

    # ── Encontrar sinais ────────────────────────────────────────────────────
    signals = autoscan_breakouts(
        candles,
        sr_lookback   = sr_lookback,
        bb_period     = bb_period,
        rr_ratio      = rr_ratio,
        min_breakout  = min_breakout,
        min_gap       = min_gap,
        squeeze_ratio = squeeze_ratio,
        expansao_min  = expansao_min,
        stop_offset   = stop_offset,
    )
    print(f"Sinais encontrados: {len(signals)}")

    # ── Avaliar cada sinal e calcular P&L composto ──────────────────────────
    capital     = args.capital
    resultados  = []
    wins = losses = pending = 0
    total_pnl   = 0.0

    for sig in signals:
        lot    = get_lot(capital)
        result = avaliar_resultado(sig, candles)
        pnl    = calc_pnl(sig, result, lot)
        capital = max(0, capital + pnl)

        if result == 'win':    wins    += 1
        elif result == 'loss': losses  += 1
        else:                  pending += 1
        total_pnl += pnl

        from datetime import datetime, timezone
        dt = datetime.fromtimestamp(sig['time'], tz=timezone.utc)
        resultados.append({
            'datetime'  : dt.strftime('%Y-%m-%d %H:%M'),
            'dir'       : '▲ COMPRA' if sig['direction'] == 'buy' else '▼ VENDA',
            'entry'     : sig['entry'],
            'sl'        : sig['stop_loss'],
            'tp'        : sig['take_profit'],
            'lot'       : lot,
            'resultado' : result.upper(),
            'pnl'       : pnl,
            'capital'   : round(capital, 2),
        })

    # ── Relatório ──────────────────────────────────────────────────────────
    print(f"\n{'─'*60}")
    print(f"{'DT':<17} {'DIR':<10} {'ENTRY':<8} {'SL':<8} {'TP':<8} {'LOT':<5} {'RESULT':<8} {'P&L':>8} {'CAP':>8}")
    print(f"{'─'*60}")
    for r in resultados:
        print(f"{r['datetime']:<17} {r['dir']:<10} {r['entry']:<8.5f} {r['sl']:<8.5f} {r['tp']:<8.5f} "
              f"{r['lot']:<5.2f} {r['resultado']:<8} {r['pnl']:>+8.2f} {r['capital']:>8.2f}")

    total = wins + losses + pending
    wr    = wins / total * 100 if total else 0
    print(f"\n{'═'*60}")
    print(f"  Trades      : {total}  ({wins}W / {losses}L{' / ' + str(pending) + ' pend' if pending else ''})")
    print(f"  Win Rate    : {wr:.1f}%")
    print(f"  P&L Total   : +${total_pnl:,.2f}" if total_pnl >= 0 else f"  P&L Total   : -${abs(total_pnl):,.2f}")
    print(f"  Capital     : ${args.capital:.2f} → ${capital:.2f}")
    print(f"{'═'*60}")

    # Metas Fase 1A
    pf_wins   = sum(r['pnl'] for r in resultados if r['pnl'] > 0)
    pf_losses = sum(-r['pnl'] for r in resultados if r['pnl'] < 0)
    pf = pf_wins / pf_losses if pf_losses > 0 else float('inf')
    print(f"  Profit Factor: {pf:.2f}")
    if wr >= 55 and pf >= 1.5:
        print("  ✔ METAS FASE 1A ATINGIDAS (WR≥55% e PF≥1.5)")
    print()


if __name__ == '__main__':
    main()
