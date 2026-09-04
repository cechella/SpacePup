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


def carregar_csv_para_candles(path: str) -> list[dict]:
    """
    Lê um CSV histórico EURUSD M5 e retorna lista de dicts {time, open, high, low, close}.
    Detecta automaticamente os formatos:
      - Dukascopy:      America/Sao_Paulo,open,high,low,close,volume (índice com timezone)
      - Investing.com:  EURUSD Historical Data\nDate,Open,High,Low,Close,Change(Pips),...
      - Merged/padrão:  time_utc,open,high,low,close,volume (ISO 8601)
    """
    from datetime import datetime, timezone

    with open(path, encoding='utf-8', errors='replace') as f:
        primeira = f.readline().strip()
        segunda  = f.readline().strip()

    # ── Formato Investing.com (primeira linha = título, segunda = header) ──
    if 'Change' in segunda or primeira.upper().startswith('EURUSD HISTORICAL'):
        rows = []
        with open(path, encoding='utf-8', errors='replace') as f:
            for i, line in enumerate(f):
                if i < 2:   # pula título e header
                    continue
                parts = line.strip().split(',')
                if len(parts) < 5:
                    continue
                try:
                    dt = datetime.strptime(parts[0].strip(), '%m/%d/%Y %H:%M')
                    o, h, l, c = float(parts[1]), float(parts[2]), float(parts[3]), float(parts[4])
                    rows.append({'time': int(dt.timestamp()), 'open': o, 'high': h, 'low': l, 'close': c})
                except Exception:
                    pass
        rows.sort(key=lambda r: r['time'])
        return rows

    # ── Formato Dukascopy / Merged (pandas com índice de data) ────────────
    df = pd.read_csv(path, index_col=0, parse_dates=True)
    df.columns = [c.lower().split('(')[0].strip() for c in df.columns]
    if df.index.tz is None:
        df.index = df.index.tz_localize('UTC')
    else:
        df.index = df.index.tz_convert('UTC')
    df = df.sort_index()
    return [
        {'time': int(row.Index.timestamp()), 'open': row.open,
         'high': row.high, 'low': row.low, 'close': row.close}
        for row in df.itertuples()
    ]


def carregar_pasta(pasta: str) -> tuple[list[dict], str]:
    """
    Mescla todos os CSVs de uma pasta em ordem cronológica.
    Ignora arquivos vazios (ex: sábados). Retorna (candles, descricao).
    """
    import glob
    arquivos = sorted(glob.glob(os.path.join(pasta, '*.csv')))
    if not arquivos:
        raise ValueError(f'Nenhum CSV encontrado em: {pasta}')

    todos = []
    vazios = 0
    for arq in arquivos:
        try:
            candles = carregar_csv_para_candles(arq)
            if candles:
                todos.extend(candles)
            else:
                vazios += 1
        except Exception:
            vazios += 1

    if not todos:
        raise ValueError('Nenhum candle válido nos CSVs da pasta')

    # Ordena e remove duplicatas de timestamp
    todos.sort(key=lambda c: c['time'])
    todos = [c for i, c in enumerate(todos) if i == 0 or c['time'] != todos[i - 1]['time']]

    desc = f'{pasta} ({len(arquivos) - vazios} arquivos, {vazios} vazios ignorados)'
    return todos, desc


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Autoscan browser — réplica exata do indicators.ts'
    )
    parser.add_argument('--csv', default=None,
                        help='CSV único com dados históricos')
    parser.add_argument('--dir', default=None,
                        help='Pasta com múltiplos CSVs Dukascopy (mescla automaticamente)')
    parser.add_argument('--capital', type=float, default=100.0,
                        help='Capital inicial em USD (padrão: 100)')
    parser.add_argument('--semanal', action='store_true',
                        help='Exibe relatório detalhado por semana')
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
    if args.dir:
        candles, fonte = carregar_pasta(args.dir)
    elif args.csv:
        candles = carregar_csv_para_candles(args.csv)
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

    # ── Relatório semanal (--semanal) ─────────────────────────────────────
    if args.semanal and resultados:
        from datetime import datetime, timezone
        from collections import defaultdict

        semanas: dict = defaultdict(lambda: {'trades': 0, 'wins': 0, 'losses': 0,
                                              'pnl': 0.0, 'cap_ini': 0.0, 'cap_fim': 0.0})
        cap_semana_ini = args.capital

        # Agrupa por semana ISO (ano-semana)
        for idx, r in enumerate(resultados):
            dt   = datetime.strptime(r['datetime'], '%Y-%m-%d %H:%M')
            chave = dt.strftime('%Y-W%W')  # ex: "2026-W32"
            sem  = semanas[chave]
            if sem['trades'] == 0:
                sem['cap_ini'] = cap_semana_ini
            sem['trades'] += 1
            if r['resultado'] == 'WIN':
                sem['wins'] += 1
            elif r['resultado'] == 'LOSS':
                sem['losses'] += 1
            sem['pnl'] += r['pnl']
            sem['cap_fim'] = r['capital']
            # Atualiza capital inicial da próxima semana
            if idx + 1 < len(resultados):
                dt_next = datetime.strptime(resultados[idx + 1]['datetime'], '%Y-%m-%d %H:%M')
                if dt_next.strftime('%Y-W%W') != chave:
                    cap_semana_ini = r['capital']

        print(f"\n{'─'*72}")
        print(f"{'RELATÓRIO SEMANAL':^72}")
        print(f"{'─'*72}")
        print(f"{'SEMANA':<12} {'T':>3} {'W':>3} {'L':>3} {'WR%':>6} {'P&L':>9} {'CAP INI':>9} {'CAP FIM':>9} {'META':<6}")
        print(f"{'─'*72}")

        total_semanas     = len(semanas)
        semanas_posit     = 0
        semanas_meta      = 0

        for chave in sorted(semanas.keys()):
            s  = semanas[chave]
            t  = s['trades']
            w  = s['wins']
            l  = s['losses']
            wr_s = w / t * 100 if t else 0
            pnl_s = s['pnl']
            ok   = '✔' if wr_s >= 55 and pnl_s > 0 else ''
            if pnl_s > 0:
                semanas_posit += 1
            if wr_s >= 55 and pnl_s > 0:
                semanas_meta += 1
            pnl_str = f"+${pnl_s:,.2f}" if pnl_s >= 0 else f"-${abs(pnl_s):,.2f}"
            print(f"{chave:<12} {t:>3} {w:>3} {l:>3} {wr_s:>5.1f}% {pnl_str:>9} "
                  f"${s['cap_ini']:>8.2f} ${s['cap_fim']:>8.2f} {ok}")

        print(f"{'─'*72}")
        print(f"Semanas lucrativas : {semanas_posit}/{total_semanas} "
              f"({semanas_posit/total_semanas*100:.0f}%)")
        print(f"Semanas com meta   : {semanas_meta}/{total_semanas} "
              f"(WR≥55% e P&L>0)")
        print()


if __name__ == '__main__':
    main()
