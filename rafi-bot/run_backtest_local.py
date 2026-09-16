"""
run_backtest_local.py — Backtest sem Supabase (usa config.yaml como fonte)
Uso: python3 run_backtest_local.py --inicio 2026-09-01 --fim 2026-09-03 --capital 20
"""
import sys, os, yaml, logging
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Injeta config.yaml no cache do risk_manager ANTES de importar GestorRisco
import src.risk_manager as rm

def _patch_cache(config: dict):
    rm._faixas_cache = [
        (float(f[0]), float(f[1]), float(f[2]))
        for f in config.get('rafi_lote_faixas', [])
    ]
    rm._faixas_ts = float('inf')   # cache nunca expira
    rm._risco_cache = {
        'max_trades_simultaneos': config.get('max_trades_simultaneos', 1),
        'tamanho_lote_minimo':    config.get('tamanho_lote_minimo', 0.01),
        'lote_maximo':            config.get('lote_maximo', 100.0),
        'par':                    config.get('par', 'EURUSD'),
        'max_losses_seguidos':    config.get('max_losses_seguidos', 999),
        'dd_semanal_reducao':     0.20,
    }
    rm._risco_ts = float('inf')

import argparse, pandas as pd
from backtest.engine import BacktestCSV
from backtest.report import gerar_relatorio

def main():
    p = argparse.ArgumentParser()
    p.add_argument('--m5',      default='data/EURUSD_M5_16meses.csv')
    p.add_argument('--capital', type=float, default=20.0)
    p.add_argument('--inicio',  default='2026-09-01')
    p.add_argument('--fim',     default='2026-09-03')
    p.add_argument('--config',  default='config.yaml')
    args = p.parse_args()

    logging.basicConfig(level=logging.WARNING, format='%(asctime)s | %(levelname)s | %(message)s')

    with open(args.config) as f:
        config = yaml.safe_load(f)

    _patch_cache(config)

    # Lê CSV — formato MT5 export (7 colunas, datetime como índice implícito)
    raw = pd.read_csv(args.m5, sep='\t', header=0)
    # MT5 exporta: Data+Hora | Open | High | Low | Close | VolTick | VolReal
    # O header tem 6 nomes mas são 7 colunas → pandas usa col0 como index
    if raw.shape[1] == 6:
        # index já é datetime, colunas são Open/High/Low/Close/Vol/extra
        raw.index = pd.to_datetime(raw.index, utc=True)
        raw.columns = ['open','high','low','close','vol1','vol2']
        df = raw[['open','high','low','close']].copy()
        df['volume'] = raw['vol1']
    else:
        raw.columns = ['time','open','high','low','close','volume']
        raw['time'] = pd.to_datetime(raw['time'], utc=True)
        df = raw.set_index('time')[['open','high','low','close','volume']]
    df = df[(df.index >= args.inicio) & (df.index <= args.fim + ' 23:59')]
    print(f"\nCandles carregados: {len(df)} | {df.index[0]} → {df.index[-1]}")

    if len(df) < 10:
        print("ERRO: Dados insuficientes para o período solicitado.")
        return

    bt = BacktestCSV(config, df, df.resample('15min').agg(
        {'open':'first','high':'max','low':'min','close':'last','volume':'sum'}
    ).dropna(), capital=args.capital)

    trades = bt.executar()

    if not trades:
        print("Nenhum trade gerado no período.")
        return

    df_t = pd.DataFrame(trades)
    df_t['hora_utc'] = pd.to_datetime(df_t['timestamp_entrada']).dt.hour

    # Sessões
    london    = df_t[(df_t['hora_utc'] >= 7)  & (df_t['hora_utc'] < 16)]
    ny        = df_t[(df_t['hora_utc'] >= 13) & (df_t['hora_utc'] < 21)]
    overlap   = df_t[(df_t['hora_utc'] >= 13) & (df_t['hora_utc'] < 16)]
    total_dia = df_t

    print(f"\n{'='*55}")
    print(f"  BACKTEST  {args.inicio} → {args.fim}  |  Capital: ${args.capital:.2f}")
    print(f"{'='*55}")
    print(f"  Todos os trades:               {len(total_dia):>4} trades")
    print(f"  Sessão Londres  (07-16 UTC):   {len(london):>4} trades")
    print(f"  Sessão Nova York(13-21 UTC):   {len(ny):>4} trades")
    print(f"  Sobreposição LN/NY (13-16 UTC):{len(overlap):>4} trades  ← FOCO")
    print(f"{'='*55}")

    if len(overlap) > 0:
        wins = overlap[overlap['pnl_usd'] > 0]
        loss = overlap[overlap['pnl_usd'] < 0]
        print(f"\n  SOBREPOSIÇÃO DETALHADA:")
        print(f"  Wins:   {len(wins)} | Losses: {len(loss)}")
        print(f"  WR:     {len(wins)/len(overlap)*100:.1f}%")
        print(f"  P&L:    ${overlap['pnl_usd'].sum():.2f}")
        print(f"\n  Trades durante sobreposição:")
        for _, t in overlap.iterrows():
            icon = '✓' if t['pnl_usd'] > 0 else '✗'
            ts = pd.to_datetime(t['timestamp_entrada'])
            print(f"  {icon} {ts.strftime('%d/%m %H:%M UTC')} "
                  f"{t['sinal'].upper():<4} {t['lote']}L "
                  f"SL={t['risco_pips']:.1f}p "
                  f"→ ${t['pnl_usd']:+.2f} "
                  f"(entrada {t['preco_entrada']:.5f})")

    rel = gerar_relatorio(trades, capital_inicial=args.capital)
    print(f"\n  RESULTADO GERAL DO PERÍODO:")
    print(f"  Capital final:  ${rel.get('capital_final', rel.get('saldo_final', 0)):.2f}")
    print(f"  Total trades:   {rel.get('total_trades', rel.get('n_trades', len(trades)))}")
    wr = rel.get('win_rate', rel.get('win_rate_pct', 0))
    pf = rel.get('profit_factor', 0)
    print(f"  Win rate:       {wr:.1f}%")
    print(f"  Profit factor:  {pf:.2f}")
    print(f"{'='*55}\n")

if __name__ == '__main__':
    main()
