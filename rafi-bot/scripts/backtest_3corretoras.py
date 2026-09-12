"""
backtest_3corretoras.py — Simula as 3 corretoras (Pepperstone, Tickmill, Exness)
operando em paralelo no mesmo EURUSD M5, cada uma com seu próprio capital e custos.

Como funciona:
  Os 3 bots veem o mesmo candle M5 ao mesmo tempo. Quando o autoscan detecta um
  sinal, todos os 3 entram simultaneamente — cada um na sua conta, com seu lote
  determinado pelo capital individual. O relatório final soma os 3.

Uso:
  py scripts\\backtest_3corretoras.py \\
    --m5 data\\pepperstone_EURUSD_M5.csv \\
    --inicio 2026-03-10 --fim 2026-09-10 \\
    --capital-pepper 20 --capital-tickmill 20 --capital-exness 20 \\
    --rr 1.3

Adicione --slippage-escalonado para simular derrapagem real em lotes grandes.
"""

import argparse
import logging
import os
import sys
import hashlib
import yaml
import pandas as pd
from datetime import datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backtest.engine import Backtest, BacktestCSV
from backtest.report import gerar_relatorio, exportar_csv_detalhado


# Faixas de lote para backtest offline.
# Espelham a tabela rafi_lote_faixas do Supabase — atualizar aqui quando
# atualizar no dashboard. O bot em produção (executor.py + risk_manager.py)
# NUNCA usa estes valores: lê exclusivamente do Supabase.
_FAIXAS_BACKTEST = [
    (0,       20,          0.10),
    (20,      50,          0.20),
    (50,      100,         0.50),
    (100,     200,         1.00),
    (200,     500,         2.00),
    (500,     1_000,       4.00),
    (1_000,   2_000,       8.00),
    (2_000,   5_000,      16.00),
    (5_000,   10_000,     30.00),
    (10_000,  20_000,     60.00),
    (20_000,  50_000,    100.00),
    (50_000,  999_999_999, 100.00),
]


CORRETORAS = [
    {
        'nome'      : 'Pepperstone Razor',
        'capital'   : None,          # preenchido via --capital-pepper
        'spread'    : 0.1,           # spread raw Razor (pips)
        'slippage'  : 0.3,           # slippage base (pips)
        'comissao'  : 6.0,           # $6/lote round trip ($3 cada lado)
        'arg_capital': 'capital_pepper',
    },
    {
        'nome'      : 'Tickmill Raw',
        'capital'   : None,
        'spread'    : 0.1,
        'slippage'  : 0.3,
        'comissao'  : 6.0,           # $6/lote round trip (Raw = mesma estrutura do Razor)
        'arg_capital': 'capital_tickmill',
    },
    {
        'nome'      : 'Exness Raw Spread',
        'capital'   : None,
        'spread'    : 0.0,           # spread zero (Raw Spread)
        'slippage'  : 0.4,           # ligeiramente maior pela execução asiática
        'comissao'  : 7.0,           # $7/lote round trip ($3.50 cada lado)
        'arg_capital': 'capital_exness',
    },
]


def configurar_logging(nivel: str = 'INFO') -> None:
    os.makedirs('logs', exist_ok=True)
    fmt = '%(asctime)s | %(levelname)s | %(message)s'
    logging.basicConfig(
        level=getattr(logging, nivel.upper(), logging.INFO),
        format=fmt,
        handlers=[
            logging.FileHandler('logs/backtest_3corretoras.log', encoding='utf-8'),
            logging.StreamHandler(sys.stdout),
        ],
    )


def rodar_backtest_corretora(cfg_corretora: dict, config_base: dict,
                              df_m5: pd.DataFrame,
                              inicio: str, fim: str,
                              slippage_escalonado: bool,
                              csv_dir: str) -> tuple[dict, list]:
    """Roda o backtest de uma corretora e retorna (relatorio, trades)."""
    nome     = cfg_corretora['nome']
    capital  = cfg_corretora['capital']
    logger   = logging.getLogger(__name__)
    logger.info(f"\n{'='*60}\n  CORRETORA: {nome} | Capital: ${capital:.2f}\n{'='*60}")

    # Copia config e aplica custos específicos da corretora
    config = dict(config_base)
    config['spread_pips']        = cfg_corretora['spread']
    config['slippage_pips']      = cfg_corretora['slippage']
    config['comissao_por_lote']  = cfg_corretora['comissao']
    config['slippage_escalonado'] = slippage_escalonado

    # Reamostrar M15 do M5
    df_m15 = df_m5.resample('15min').agg({
        'open': 'first', 'high': 'max', 'low': 'min',
        'close': 'last', 'volume': 'sum',
    }).dropna()

    bt = Backtest(config, df_m5, df_m15, capital=capital)

    # Filtrar período
    if inicio:
        dt_ini = pd.Timestamp(inicio, tz='UTC')
        dt_fim = pd.Timestamp(fim, tz='UTC') + pd.Timedelta(hours=23, minutes=59) if fim \
                 else bt.df_m5.index.max()
        bt.df_m5  = bt.df_m5.loc[dt_ini:dt_fim]
        bt.df_m15 = bt.df_m15.loc[dt_ini:dt_fim]

    trades = bt.executar()

    relatorio = gerar_relatorio(
        trades,
        capital_inicial=capital,
        equity_curve=bt.equity_curve,
    )

    # Exportar CSV individual por corretora
    if trades and csv_dir:
        nome_arquivo = nome.lower().replace(' ', '_')
        caminho_csv = os.path.join(csv_dir, f'trades_{nome_arquivo}.csv')
        exportar_csv_detalhado(trades, caminho_csv)
        logger.info(f"CSV exportado: {caminho_csv}")

    return relatorio, trades


def imprimir_relatorio_combinado(resultados: list[tuple[dict, dict, list]],
                                  inicio: str, fim: str,
                                  slippage_escalonado: bool) -> None:
    """Imprime o relatório final combinado das 3 corretoras."""
    sep = '=' * 68
    print(f"\n{sep}")
    print(f"  RELATÓRIO COMBINADO — {len(resultados)} CORRETORAS SIMULTÂNEAS")
    print(f"  Período: {inicio} → {fim}")
    if slippage_escalonado:
        print(f"  ⚠  Slippage escalonado ATIVO (realismo em lotes grandes)")
    print(sep)

    total_capital_ini  = 0.0
    total_capital_fim  = 0.0
    total_ganhos       = 0
    total_perdas       = 0
    total_comissao     = 0.0
    total_trades       = 0
    pf_numerador       = 0.0
    pf_denominador     = 0.0

    print(f"\n{'Corretora':<22} {'Cap.Ini':>9} {'Cap.Final':>12} {'WR':>7} {'PF':>7} "
          f"{'Trades':>7} {'Drawdown':>10} {'Comissão':>10}")
    print('-' * 90)

    for cfg, rel, trades in resultados:
        cap_ini   = cfg['capital']
        cap_fim   = rel.get('capital_final', cap_ini)
        wr        = rel.get('win_rate_pct', 0)
        pf        = rel.get('profit_factor', 0)
        n_trades  = rel.get('total_trades', 0)
        dd        = rel.get('drawdown_max_pct', 0)
        ganhos    = rel.get('ganhos', 0)      # nº de trades vencedores
        perdas    = rel.get('perdas', 0)      # nº de trades perdedores

        # Custo total de comissão
        comissao_total = sum(
            t.get('lote', 0) * cfg['comissao'] for t in trades
        )

        print(f"{cfg['nome']:<22} ${cap_ini:>8.2f} ${cap_fim:>11,.2f} "
              f"{wr:>6.1f}% {pf:>7.3f} {n_trades:>7} {dd:>9.1f}% ${comissao_total:>9,.2f}")

        total_capital_ini  += cap_ini
        total_capital_fim  += cap_fim
        total_ganhos       += ganhos
        total_perdas       += perdas
        total_comissao     += comissao_total
        total_trades       += n_trades

        lucros_trades  = [t['pnl_usd'] for t in trades if t.get('pnl_usd', 0) > 0]
        perdas_trades  = [t['pnl_usd'] for t in trades if t.get('pnl_usd', 0) < 0]
        pf_numerador   += sum(lucros_trades)
        pf_denominador += abs(sum(perdas_trades))

    print('-' * 90)

    retorno_pct = ((total_capital_fim - total_capital_ini) / total_capital_ini * 100) \
                  if total_capital_ini > 0 else 0
    wr_total    = (total_ganhos / total_trades * 100) if total_trades > 0 else 0
    pf_total    = (pf_numerador / pf_denominador) if pf_denominador > 0 else 0
    pip_value   = total_capital_fim / total_capital_ini * 0.10 * 10 * len(resultados) \
                  if total_capital_ini > 0 else 0  # estimativa

    print(f"{'TOTAL COMBINADO':<22} ${total_capital_ini:>8.2f} ${total_capital_fim:>11,.2f} "
          f"{wr_total:>6.1f}% {pf_total:>7.3f} {total_trades:>7}        "
          f"  ${total_comissao:>9,.2f}")

    print(f"\n{sep}")
    print(f"  RESUMO EXECUTIVO")
    print(f"{sep}")
    print(f"  Capital inicial combinado : ${total_capital_ini:>12,.2f}")
    print(f"  Capital final combinado   : ${total_capital_fim:>12,.2f}")
    print(f"  Lucro líquido combinado   : ${total_capital_fim - total_capital_ini:>12,.2f}")
    print(f"  Retorno sobre capital     : {retorno_pct:>12,.1f}%")
    print(f"  Win Rate combinado        : {wr_total:>11.1f}%")
    print(f"  Profit Factor combinado   : {pf_total:>12.3f}")
    print(f"  Total de trades (3 bots)  : {total_trades:>12,}")
    print(f"  Comissão total paga       : ${total_comissao:>12,.2f}")
    print(f"  Valor por pip no pico     : ${len(resultados) * 100 * 10:>12,.0f}  "
          f"({len(resultados)} contas × 100 lotes)")
    print(f"{sep}\n")

    # Metas Fase 1A
    if wr_total >= 55 and pf_total >= 1.5:
        print("  ✔  METAS DE FASE 1A ATINGIDAS: WR ≥55% e PF ≥1.5")
    else:
        print("  ✘  Metas de Fase 1A não atingidas — revisar parâmetros")
    print()


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Backtest simultâneo de 3 corretoras — Bot RAFI Autoscan'
    )
    parser.add_argument('--m5',              required=True,
                        help='CSV com dados M5 (mesmo arquivo para as 3 corretoras)')
    parser.add_argument('--config',          default='config.yaml')
    parser.add_argument('--inicio',          default='2026-03-10')
    parser.add_argument('--fim',             default='2026-09-10')
    parser.add_argument('--rr',              type=float, default=None)
    parser.add_argument('--capital-pepper',  type=float, default=20.0, dest='capital_pepper',
                        help='Capital inicial Pepperstone (default: $20)')
    parser.add_argument('--capital-tickmill', type=float, default=20.0, dest='capital_tickmill',
                        help='Capital inicial Tickmill (default: $20)')
    parser.add_argument('--capital-exness',  type=float, default=20.0, dest='capital_exness',
                        help='Capital inicial Exness (default: $20)')
    parser.add_argument('--slippage-escalonado', action='store_true', dest='slippage_escalonado',
                        help='Ativa slippage extra por tamanho de lote (mais realista)')
    parser.add_argument('--csv-dir',         default='logs', dest='csv_dir',
                        help='Diretório para CSVs individuais por corretora (default: logs/)')
    parser.add_argument('--log',             default='INFO')
    args = parser.parse_args()

    configurar_logging(args.log)
    logger = logging.getLogger(__name__)

    # Carrega config base
    with open(args.config, 'rb') as f:
        _raw = f.read()
    config = yaml.safe_load(_raw.decode('utf-8'))

    if args.rr is not None:
        config['ratio_risco_retorno'] = args.rr

    # Garante que as faixas de lote estão no config para o backtest offline.
    # Se o config.yaml já tiver rafi_lote_faixas (sincronizado do Supabase),
    # os valores dele prevalecem. Caso contrário usa _FAIXAS_BACKTEST acima.
    if 'rafi_lote_faixas' not in config or not config['rafi_lote_faixas']:
        config['rafi_lote_faixas'] = _FAIXAS_BACKTEST
        logger.info("rafi_lote_faixas: usando tabela embutida no script (config.yaml sem a chave)")

    # Carrega CSV M5 uma vez (compartilhado pelas 3 corretoras)
    logger.info(f"Carregando dados M5: {args.m5}")
    bt_csv = BacktestCSV.de_csv(config, caminho_m5=args.m5, caminho_m15=args.m5, capital=20.0)
    df_m5_completo = bt_csv.df_m5

    # Filtrar período antes de passar para os backtests individuais
    dt_ini = pd.Timestamp(args.inicio, tz='UTC')
    dt_fim = pd.Timestamp(args.fim, tz='UTC') + pd.Timedelta(hours=23, minutes=59)
    df_m5 = df_m5_completo.loc[dt_ini:dt_fim]
    logger.info(f"Período: {args.inicio} → {args.fim} | {len(df_m5):,} candles M5")

    os.makedirs(args.csv_dir, exist_ok=True)

    # Preenche capital de cada corretora
    CORRETORAS[0]['capital'] = args.capital_pepper
    CORRETORAS[1]['capital'] = args.capital_tickmill
    CORRETORAS[2]['capital'] = args.capital_exness

    resultados = []
    for cfg in CORRETORAS:
        rel, trades = rodar_backtest_corretora(
            cfg_corretora       = cfg,
            config_base         = config,
            df_m5               = df_m5,
            inicio              = args.inicio,
            fim                 = args.fim,
            slippage_escalonado = args.slippage_escalonado,
            csv_dir             = args.csv_dir,
        )
        resultados.append((cfg, rel, trades))

    imprimir_relatorio_combinado(
        resultados          = resultados,
        inicio              = args.inicio,
        fim                 = args.fim,
        slippage_escalonado = args.slippage_escalonado,
    )


if __name__ == '__main__':
    main()
