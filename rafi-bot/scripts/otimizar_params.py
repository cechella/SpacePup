"""
otimizar_params.py — Otimizador de parâmetros do Autoscan via Grid Search + Walk-Forward

Fluxo:
  1. Carrega dados históricos (--csv, --dir ou múltiplos --csv)
  2. Divide 70% treino / 30% validação (walk-forward cronológico)
  3. Grid search em 2.916 combinações no conjunto de TREINO
  4. Top 10 combinações re-avaliadas no conjunto de VALIDAÇÃO (out-of-sample)
  5. Relatório: "Com params X → resultado Y (treino) | Y (OOS)"
  6. --aplicar: grava os melhores parâmetros no Supabase (perfil 'simulator')

Uso:
  python scripts/otimizar_params.py --csv data/eurusd_m5.csv
  python scripts/otimizar_params.py --dir data/dukascopy/
  python scripts/otimizar_params.py --csv a.csv --csv b.csv --aplicar
"""

import argparse
import math
import os
import sys
import time
from datetime import datetime, timezone
from itertools import product

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from autoscan_browser import (
    autoscan_breakouts,
    avaliar_resultado,
    calc_pnl,
    get_lot,
    carregar_csv_para_candles,
    carregar_pasta,
)


# ── Grade de parâmetros (2.916 combinações: 4×3×3×3×3×3×3) ──────────────────

GRADE = {
    'sr_lookback'   : [10, 15, 20, 25],
    'bb_period'     : [6, 8, 10],
    'rr_ratio'      : [1.3, 1.5, 2.0],
    'min_breakout'  : [0.00002, 0.00003, 0.00005],
    'min_gap'       : [5, 8, 12],
    'squeeze_ratio' : [0.0008, 0.0012, 0.0016],
    'stop_offset'   : [0.00010, 0.00015, 0.00020],
}

# expansao_min fixo em 1.05 (pouco impacto, reduz explosion combinatória)
EXPANSAO_MIN = 1.05

# Mínimo de trades para uma combinação ser considerada válida
MIN_TRADES = 5


def simular(candles: list[dict], params: dict, capital_ini: float = 100.0) -> dict:
    """
    Roda o autoscan com os parâmetros dados e retorna métricas de desempenho.
    """
    signals = autoscan_breakouts(
        candles,
        sr_lookback   = params['sr_lookback'],
        bb_period     = params['bb_period'],
        rr_ratio      = params['rr_ratio'],
        min_breakout  = params['min_breakout'],
        min_gap       = params['min_gap'],
        squeeze_ratio = params['squeeze_ratio'],
        expansao_min  = EXPANSAO_MIN,
        stop_offset   = params['stop_offset'],
    )

    capital = capital_ini
    wins = losses = pending = 0
    pnl_total = pnl_wins = pnl_losses_abs = 0.0

    for sig in signals:
        lot    = get_lot(capital)
        result = avaliar_resultado(sig, candles)
        pnl    = calc_pnl(sig, result, lot)
        capital = max(0, capital + pnl)

        if result == 'win':
            wins += 1
            pnl_wins += pnl
        elif result == 'loss':
            losses += 1
            pnl_losses_abs += abs(pnl)
        else:
            pending += 1
        pnl_total += pnl

    total = wins + losses
    wr    = wins / total if total > 0 else 0.0
    pf    = pnl_wins / pnl_losses_abs if pnl_losses_abs > 0 else (float('inf') if pnl_wins > 0 else 0.0)

    # Score composto: WR × PF × log(total+1) — equilibra taxa, fator e volume de trades
    score = 0.0
    if total >= MIN_TRADES:
        score = wr * min(pf, 5.0) * math.log(total + 1)

    return {
        'total'   : total,
        'pending' : pending,
        'wins'    : wins,
        'losses'  : losses,
        'wr'      : wr,
        'pf'      : pf,
        'pnl'     : pnl_total,
        'capital' : capital,
        'score'   : score,
    }


def gravar_supabase(params: dict, metricas: dict) -> bool:
    """
    Grava os melhores parâmetros no Supabase (perfil 'simulator').
    Retorna True em caso de sucesso.
    """
    try:
        from supabase import create_client
        from pathlib import Path

        env_path = Path(__file__).parent.parent / '.env'
        if env_path.exists():
            for line in env_path.read_text().splitlines():
                if '=' in line and not line.startswith('#'):
                    k, v = line.split('=', 1)
                    os.environ.setdefault(k.strip(), v.strip())

        url = os.getenv('SUPABASE_URL', '')
        key = os.getenv('SUPABASE_KEY', '')
        if not url or not key or 'xxxx' in url:
            print("[Supabase] Credenciais não configuradas — parâmetros não gravados.")
            return False

        supa = create_client(url, key)

        payload = {
            'profile'                   : 'simulator',
            'sr_lookback'               : params['sr_lookback'],
            'bb_periodo'                : params['bb_period'],
            'ratio_risco_retorno'       : params['rr_ratio'],
            'autoscan_min_breakout'     : params['min_breakout'],
            'autoscan_min_gap_candles'  : params['min_gap'],
            'bb_limiar_estreita'        : params['squeeze_ratio'],
            'autoscan_stop_offset'      : params['stop_offset'],
            'bb_squeeze_expansao_min'   : EXPANSAO_MIN,
            # Metadados do otimizador
            'otimizador_wr'             : round(metricas['wr'] * 100, 1),
            'otimizador_pf'             : round(metricas['pf'], 2),
            'otimizador_pnl'            : round(metricas['pnl'], 2),
            'otimizador_trades'         : metricas['total'],
            'otimizador_updated_at'     : datetime.now(timezone.utc).isoformat(),
        }

        supa.table('rafi_bot_config').upsert(payload, on_conflict='profile').execute()
        return True

    except Exception as e:
        print(f"[Supabase] Erro ao gravar: {e}")
        return False


def formatar_params(p: dict) -> str:
    """Linha compacta com os parâmetros."""
    return (
        f"sr={p['sr_lookback']:>2} bb={p['bb_period']} rr={p['rr_ratio']:.1f} "
        f"brk={p['min_breakout']:.5f} gap={p['min_gap']:>2} "
        f"sq={p['squeeze_ratio']:.4f} off={p['stop_offset']:.5f}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Otimizador de parâmetros do Autoscan — Grid Search + Walk-Forward'
    )
    parser.add_argument('--csv', action='append', default=[],
                        help='CSV histórico (pode repetir para múltiplos arquivos)')
    parser.add_argument('--dir', default=None,
                        help='Pasta com múltiplos CSVs (mescla automaticamente)')
    parser.add_argument('--capital', type=float, default=100.0,
                        help='Capital inicial em USD (padrão: 100)')
    parser.add_argument('--split', type=float, default=0.70,
                        help='Fração para treino (padrão: 0.70 = 70%%)')
    parser.add_argument('--top', type=int, default=10,
                        help='Número de top combinações a exibir (padrão: 10)')
    parser.add_argument('--aplicar', action='store_true',
                        help='Grava o melhor resultado no Supabase (perfil simulator)')
    args = parser.parse_args()

    # ── Carregar candles ────────────────────────────────────────────────────
    todos_candles: list[dict] = []

    if args.dir:
        candles_dir, desc_dir = carregar_pasta(args.dir)
        todos_candles.extend(candles_dir)
        print(f"[DIR] {desc_dir}: {len(candles_dir)} candles")

    for csv_path in args.csv:
        c = carregar_csv_para_candles(csv_path)
        todos_candles.extend(c)
        print(f"[CSV] {os.path.basename(csv_path)}: {len(c)} candles")

    if not todos_candles:
        # Sem argumentos: usa os CSVs do diretório data/ se existirem
        data_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'data')
        csvs = []
        if os.path.isdir(data_dir):
            import glob
            csvs = glob.glob(os.path.join(data_dir, '*.csv'))
        if csvs:
            for f in sorted(csvs):
                c = carregar_csv_para_candles(f)
                todos_candles.extend(c)
                print(f"[data/] {os.path.basename(f)}: {len(c)} candles")
        else:
            print("ERRO: Nenhum dado histórico encontrado.")
            print("  Use: --csv caminho.csv  ou  --dir pasta/")
            sys.exit(1)

    # Ordena e remove duplicatas
    todos_candles.sort(key=lambda c: c['time'])
    todos_candles = [
        c for i, c in enumerate(todos_candles)
        if i == 0 or c['time'] != todos_candles[i - 1]['time']
    ]

    n_total = len(todos_candles)
    n_treino = int(n_total * args.split)
    n_val    = n_total - n_treino

    dt_ini  = datetime.fromtimestamp(todos_candles[0]['time'],   tz=timezone.utc)
    dt_fim  = datetime.fromtimestamp(todos_candles[-1]['time'],  tz=timezone.utc)
    dt_corte = datetime.fromtimestamp(todos_candles[n_treino]['time'], tz=timezone.utc)

    candles_treino = todos_candles[:n_treino]
    candles_val    = todos_candles[n_treino:]

    # Calcula total de combinações
    n_combos = 1
    for vals in GRADE.values():
        n_combos *= len(vals)

    print(f"\n{'═'*70}")
    print(f"  OTIMIZADOR DE PARÂMETROS — AUTOSCAN EURUSD M5")
    print(f"{'═'*70}")
    print(f"  Período total  : {dt_ini:%d/%m/%Y %H:%M} → {dt_fim:%d/%m/%Y %H:%M}")
    print(f"  Candles totais : {n_total}")
    print(f"  Treino (70%)   : {n_treino} candles até {dt_corte:%d/%m/%Y %H:%M}")
    print(f"  Validação (30%): {n_val} candles")
    print(f"  Combinações    : {n_combos:,}")
    print(f"  Capital inicial: ${args.capital:.2f}")
    print(f"{'═'*70}\n")

    if n_treino < 200:
        print("⚠  AVISO: Poucos candles de treino (<200). Resultados com alto risco de overfitting.")
        print("   Recomendado: mínimo 2-3 meses de dados M5 (~8.000-12.000 candles).\n")

    # ── Grid Search no conjunto de TREINO ───────────────────────────────────
    print(f"Rodando grid search em {n_combos:,} combinações...")
    t0 = time.time()
    resultados_treino = []

    chaves = list(GRADE.keys())
    valores = [GRADE[k] for k in chaves]

    for i, combo in enumerate(product(*valores), 1):
        params = dict(zip(chaves, combo))
        met = simular(candles_treino, params, args.capital)
        resultados_treino.append((params, met))

        # Progresso a cada 10%
        if i % max(1, n_combos // 10) == 0 or i == n_combos:
            pct = i / n_combos * 100
            elapsed = time.time() - t0
            eta = elapsed / i * (n_combos - i)
            print(f"  {pct:>5.1f}%  ({i:,}/{n_combos:,})  decorrido: {elapsed:.1f}s  ETA: {eta:.0f}s")

    tempo_total = time.time() - t0
    print(f"\nGrid search concluído em {tempo_total:.1f}s\n")

    # Ordena por score decrescente
    resultados_treino.sort(key=lambda x: x[1]['score'], reverse=True)

    # Filtra apenas combos com trades suficientes
    validos = [(p, m) for p, m in resultados_treino if m['total'] >= MIN_TRADES]
    print(f"Combinações com ≥{MIN_TRADES} trades: {len(validos):,} de {n_combos:,}\n")

    top_n = validos[:args.top]

    # ── Validação OOS nos top N ──────────────────────────────────────────────
    print(f"{'─'*70}")
    print(f"  TOP {args.top} — TREINO vs. VALIDAÇÃO (out-of-sample)")
    print(f"{'─'*70}")
    print(f"{'#':>2}  {'WR_T':>6} {'PF_T':>5} {'PNL_T':>8}  {'WR_V':>6} {'PF_V':>5} {'PNL_V':>8}  PARÂMETROS")
    print(f"{'─'*70}")

    resultados_oos = []
    for rank, (params, met_t) in enumerate(top_n, 1):
        met_v = simular(candles_val, params, args.capital)
        resultados_oos.append((params, met_t, met_v))

        wr_t  = f"{met_t['wr']*100:.1f}%"
        pf_t  = f"{met_t['pf']:.2f}" if met_t['pf'] != float('inf') else "∞"
        pnl_t = f"+${met_t['pnl']:,.2f}" if met_t['pnl'] >= 0 else f"-${abs(met_t['pnl']):,.2f}"
        wr_v  = f"{met_v['wr']*100:.1f}%" if met_v['total'] >= MIN_TRADES else "poucos"
        pf_v  = f"{met_v['pf']:.2f}"      if met_v['total'] >= MIN_TRADES and met_v['pf'] != float('inf') else ("∞" if met_v['pf'] == float('inf') else "—")
        pnl_v = (f"+${met_v['pnl']:,.2f}" if met_v['pnl'] >= 0 else f"-${abs(met_v['pnl']):,.2f}") if met_v['total'] >= MIN_TRADES else "—"

        print(f"{rank:>2}. {wr_t:>6} {pf_t:>5} {pnl_t:>8}  {wr_v:>6} {pf_v:>5} {pnl_v:>8}  {formatar_params(params)}")

    print(f"{'─'*70}")

    # ── Melhor resultado OOS ─────────────────────────────────────────────────
    # Escolhe o melhor pela performance OOS (score composto) entre os top N do treino
    def score_oos(item):
        _, _, met_v = item
        if met_v['total'] < MIN_TRADES:
            return 0.0
        return met_v['score']

    resultados_oos.sort(key=score_oos, reverse=True)
    melhor_params, melhor_treino, melhor_oos = resultados_oos[0]

    print(f"\n{'═'*70}")
    print(f"  MELHOR COMBINAÇÃO (por performance OOS)")
    print(f"{'═'*70}")
    print(f"  Parâmetros:")
    for k, v in melhor_params.items():
        nome_amigavel = {
            'sr_lookback'  : 'S/R lookback (candles)',
            'bb_period'    : 'Bollinger period',
            'rr_ratio'     : 'Risk/Reward ratio',
            'min_breakout' : 'Min breakout (pips equiv)',
            'min_gap'      : 'Min gap entre sinais',
            'squeeze_ratio': 'BB squeeze ratio',
            'stop_offset'  : 'Stop offset',
        }.get(k, k)
        print(f"    {nome_amigavel:<30}: {v}")

    print(f"\n  Treino  ({n_treino} candles):")
    print(f"    Trades  : {melhor_treino['total']} ({melhor_treino['wins']}W / {melhor_treino['losses']}L)")
    print(f"    Win Rate: {melhor_treino['wr']*100:.1f}%")
    pf_str_t = f"{melhor_treino['pf']:.2f}" if melhor_treino['pf'] != float('inf') else "∞"
    print(f"    Profit F: {pf_str_t}")
    print(f"    P&L     : +${melhor_treino['pnl']:,.2f}" if melhor_treino['pnl'] >= 0 else f"    P&L     : -${abs(melhor_treino['pnl']):,.2f}")

    print(f"\n  Validação OOS ({n_val} candles):")
    if melhor_oos['total'] >= MIN_TRADES:
        print(f"    Trades  : {melhor_oos['total']} ({melhor_oos['wins']}W / {melhor_oos['losses']}L)")
        print(f"    Win Rate: {melhor_oos['wr']*100:.1f}%")
        pf_str_v = f"{melhor_oos['pf']:.2f}" if melhor_oos['pf'] != float('inf') else "∞"
        print(f"    Profit F: {pf_str_v}")
        print(f"    P&L     : +${melhor_oos['pnl']:,.2f}" if melhor_oos['pnl'] >= 0 else f"    P&L     : -${abs(melhor_oos['pnl']):,.2f}")
    else:
        print(f"    Trades insuficientes no período OOS ({melhor_oos['total']} trades < {MIN_TRADES} mínimo)")

    print(f"{'═'*70}\n")

    # Aviso de overfitting
    if n_total < 5000:
        print("⚠  AVISO DE OVERFITTING")
        print(f"   Dados disponíveis: {n_total} candles (~{n_total / (288*5):.1f} semanas M5)")
        print("   Com poucos dados, estes parâmetros podem ser específicos ao período testado.")
        print("   Recomendação: colete 2-3 meses de dados antes de aplicar em produção.\n")

    # ── Gravar no Supabase (--aplicar) ──────────────────────────────────────
    if args.aplicar:
        print("Gravando melhores parâmetros no Supabase (perfil 'simulator')...")
        ok = gravar_supabase(melhor_params, melhor_oos if melhor_oos['total'] >= MIN_TRADES else melhor_treino)
        if ok:
            print("✔ Parâmetros gravados com sucesso no Supabase!")
            print("  O Admin Dashboard e o bot vão usar esses parâmetros via fallback.")
        else:
            print("✗ Não foi possível gravar no Supabase.")
            print("  Configure SUPABASE_URL e SUPABASE_KEY no arquivo rafi-bot/.env")
        print()


if __name__ == '__main__':
    main()
