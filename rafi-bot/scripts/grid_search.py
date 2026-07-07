"""
scripts/grid_search.py — Busca em grade para otimizar parâmetros da estratégia RAFI

Testa automaticamente múltiplas combinações de parâmetros e gera ranking
por Profit Factor. Roda cada backtest silenciosamente e exibe resumo ao final.

USO:
  cd rafi-bot
  py scripts/grid_search.py --m5 data\\EURUSD_M5.csv --capital 20

ATENÇÃO: overfitting — use os melhores parâmetros apenas como guia e
valide sempre em período out-of-sample antes de usar em produção.
"""

import argparse
import copy
import logging
import os
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parent.parent))

from backtest.engine import BacktestCSV
from backtest.report import gerar_relatorio

# ── Grade de parâmetros a testar ──────────────────────────────────────────────
# Cada chave é um parâmetro do config.yaml; cada valor é a lista de opções.
# Total de combinações = produto cartesiano de todos os valores.
GRADE: dict[str, list] = {
    # Lookback do swing stop — quanto de histórico para definir o nível de stop
    # Valores maiores dão mais espaço ao trade (WR tende a subir, DD sobe também)
    'swing_stop_lookback': [50, 75, 100, 150, 200],

    # Limiar mínimo do índice RAFI para aceitar sinal (>= 2.5 = padrão)
    # Valores maiores filtram sinais mais fracos — menos trades, potencialmente mais limpos
    'forca_limiar': [2.5, 3.0, 3.5],

    # Lookback do S/R dinâmico — máximo/mínimo dos últimos N candles
    # Lookback maior = nível de S/R mais significativo = breakout de nível mais forte
    'sr_lookback': [50, 75, 100],
}

# Sessões a testar: lista de dicts 'sessoes' para o config
OPCOES_SESSAO = {
    '2sessoes': {
        'toquio_londres': {'inicio': '07:00', 'fim': '09:00'},
        'londres_ny':     {'inicio': '12:00', 'fim': '16:00'},
    },
    'london_ny': {
        'londres_ny': {'inicio': '12:00', 'fim': '16:00'},
    },
    'todas_horas': {
        'tudo': {'inicio': '00:00', 'fim': '23:59'},
    },
}


def silenciar_logging() -> None:
    """Suprime logs INFO/DEBUG durante o grid search para não poluir o console."""
    logging.root.setLevel(logging.ERROR)
    for name in logging.root.manager.loggerDict:
        logging.getLogger(name).setLevel(logging.ERROR)


def carregar_config(caminho: str) -> dict:
    with open(caminho, 'r', encoding='utf-8') as f:
        return yaml.safe_load(f)


def rodar_backtest_silencioso(config: dict, caminho_m5: str, capital: float) -> dict | None:
    """
    Executa um backtest completo sem imprimir logs.
    Retorna dict com métricas ou None se falhou / poucos trades.
    """
    try:
        bt = BacktestCSV.de_csv(config, caminho_m5, caminho_m5, capital=capital)
        trades = bt.executar()
        if len(trades) < 15:
            return None
        # Redireciona logger do report para suprimir impressão do relatório
        log_report = logging.getLogger('backtest.report')
        nivel_orig = log_report.level
        log_report.setLevel(logging.CRITICAL)
        metricas = gerar_relatorio(trades, capital_inicial=capital)
        log_report.setLevel(nivel_orig)
        return metricas
    except Exception as e:
        return None


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Bot RAFI — Grid Search de parâmetros'
    )
    parser.add_argument('--m5',      required=True,   help='CSV com dados M5')
    parser.add_argument('--capital', type=float, default=20.0)
    parser.add_argument('--config',  default='config.yaml')
    parser.add_argument('--saida',   default='logs/grid_search.csv')
    parser.add_argument('--sessao',  default='2sessoes',
                        choices=list(OPCOES_SESSAO.keys()) + ['todas'],
                        help='Qual configuração de sessão usar (padrão: 2sessoes)')
    parser.add_argument('--todas-sessoes', action='store_true',
                        help='Testa todas as 3 opções de sessão (triplica o tempo)')
    args = parser.parse_args()

    silenciar_logging()

    config_base = carregar_config(args.config)

    # Montar lista de sessões a testar
    if args.todas_sessoes:
        sessoes_para_testar = list(OPCOES_SESSAO.items())
    else:
        nome = args.sessao if args.sessao in OPCOES_SESSAO else '2sessoes'
        sessoes_para_testar = [(nome, OPCOES_SESSAO[nome])]

    # Gerar combinações cartesianas dos parâmetros da GRADE
    import itertools
    chaves = list(GRADE.keys())
    combos_params = list(itertools.product(*GRADE.values()))

    total = len(combos_params) * len(sessoes_para_testar)
    print(f"\nGrid search RAFI — {total} combinações")
    print(f"Arquivo M5: {args.m5}  |  Capital: ${args.capital:.0f}")
    print("=" * 85)
    print(f"{'#':>4}  {'swing':>5}  {'forca':>5}  {'sr_lb':>5}  {'sessao':<12}  "
          f"{'trades':>6}  {'WR%':>6}  {'PF':>6}  {'capital':>8}")
    print("-" * 85)

    resultados = []
    idx = 0
    for nome_sessao, cfg_sessao in sessoes_para_testar:
        for combo in combos_params:
            idx += 1
            params = dict(zip(chaves, combo))
            cfg = copy.deepcopy(config_base)
            cfg.update(params)
            cfg['sessoes'] = cfg_sessao
            cfg['candle_corpo_minimo'] = 0.0  # filtro corpo sempre desativado (TESTE K)

            m = rodar_backtest_silencioso(cfg, args.m5, args.capital)
            if m is None:
                print(f"{idx:>4}  "
                      f"{params['swing_stop_lookback']:>5}  "
                      f"{params['forca_limiar']:>5.1f}  "
                      f"{params['sr_lookback']:>5}  "
                      f"{nome_sessao:<12}  "
                      f"{'—':>6}  {'—':>6}  {'—':>6}  {'—':>8}")
                continue

            row = {
                'swing_stop': params['swing_stop_lookback'],
                'forca':      params['forca_limiar'],
                'sr_lookback': params['sr_lookback'],
                'sessao':     nome_sessao,
                'trades':     m['total_trades'],
                'wr_pct':     m['win_rate_pct'],
                'pf':         m['profit_factor'],
                'capital_final': m['capital_final'],
                'dd_pct':     m['drawdown_max_pct'],
                'sharpe':     m['sharpe_ratio'],
            }
            resultados.append(row)

            marca = ' ◄ MELHOR' if m['profit_factor'] >= max((r['pf'] for r in resultados), default=0) else ''
            print(f"{idx:>4}  "
                  f"{params['swing_stop_lookback']:>5}  "
                  f"{params['forca_limiar']:>5.1f}  "
                  f"{params['sr_lookback']:>5}  "
                  f"{nome_sessao:<12}  "
                  f"{m['total_trades']:>6}  "
                  f"{m['win_rate_pct']:>5.1f}%  "
                  f"{m['profit_factor']:>6.3f}  "
                  f"${m['capital_final']:>7.2f}"
                  f"{marca}")

    if not resultados:
        print("\nNenhum resultado válido. Verifique o arquivo M5.")
        return

    # Ordenar por PF
    resultados.sort(key=lambda x: x['pf'], reverse=True)

    print("\n" + "=" * 85)
    print("TOP 10 — melhores Profit Factors:")
    print("-" * 85)
    print(f"{'#':>3}  {'swing':>5}  {'forca':>5}  {'sr_lb':>5}  {'sessao':<12}  "
          f"{'trades':>6}  {'WR%':>6}  {'PF':>6}  {'capital':>8}  {'DD%':>6}")
    print("-" * 85)
    for i, r in enumerate(resultados[:10], 1):
        print(f"{i:>3}  "
              f"{r['swing_stop']:>5}  "
              f"{r['forca']:>5.1f}  "
              f"{r['sr_lookback']:>5}  "
              f"{r['sessao']:<12}  "
              f"{r['trades']:>6}  "
              f"{r['wr_pct']:>5.1f}%  "
              f"{r['pf']:>6.3f}  "
              f"${r['capital_final']:>7.2f}  "
              f"{r['dd_pct']:>5.1f}%")

    # Salvar CSV
    os.makedirs(os.path.dirname(args.saida) if os.path.dirname(args.saida) else '.', exist_ok=True)
    import csv
    with open(args.saida, 'w', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=resultados[0].keys())
        writer.writeheader()
        writer.writerows(resultados)
    print(f"\nResultados completos salvos em: {args.saida}")
    print("\nPróximo passo: atualize config.yaml com os parâmetros do #1 e rode run_backtest.py")


if __name__ == '__main__':
    main()
