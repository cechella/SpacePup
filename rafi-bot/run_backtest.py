"""
run_backtest.py — Ponto de entrada do backtest (CLI)

Uso:
  python run_backtest.py --m5 data/EURUSD_M5.csv \\
                         --m15 data/EURUSD_M15.csv \\
                         --capital 20 \\
                         --config config.yaml \\
                         --grafico logs/equity.png

Se os arquivos CSV não existirem, gera dados sintéticos para teste.
"""

import argparse
import logging
import os
import sys
import yaml
import numpy as np
import pandas as pd
from datetime import datetime, timedelta, timezone

# Adiciona o diretório raiz ao path para importações relativas
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backtest.engine import Backtest, BacktestCSV
from backtest.report import gerar_relatorio


def configurar_logging(nivel: str = 'INFO', arquivo: str = 'logs/backtest.log') -> None:
    """Configura o logging para arquivo e console."""
    os.makedirs(os.path.dirname(arquivo), exist_ok=True)
    fmt = '%(asctime)s | %(levelname)s | %(message)s'
    logging.basicConfig(
        level=getattr(logging, nivel.upper(), logging.INFO),
        format=fmt,
        handlers=[
            logging.FileHandler(arquivo, encoding='utf-8'),
            logging.StreamHandler(sys.stdout),
        ],
    )


def gerar_dados_sinteticos(n_candles: int = 5000,
                            tf_minutos: int = 5,
                            semente: int = 42) -> pd.DataFrame:
    """
    Gera dados sintéticos de EURUSD para testar o backtest sem dados reais.

    Simula um random walk com drift positivo leve e volatilidade realista.
    NÃO usar para validar a estratégia — apenas para testes de código.
    """
    rng = np.random.default_rng(semente)
    inicio = datetime(2023, 1, 2, 7, 0, tzinfo=timezone.utc)
    timestamps = [inicio + timedelta(minutes=tf_minutos * i) for i in range(n_candles)]

    # Random walk: retornos com volatilidade típica do EURUSD M5
    retornos = rng.normal(0.00001, 0.00020, n_candles)
    fechamentos = 1.1000 * np.cumprod(1 + retornos)

    # Construir candles OHLCV
    ruido = rng.uniform(0.00005, 0.00020, (n_candles, 2))
    highs  = fechamentos + ruido[:, 0]
    lows   = fechamentos - ruido[:, 1]
    opens  = np.roll(fechamentos, 1)
    opens[0] = 1.1000
    volumes = rng.integers(100, 2000, n_candles).astype(float)

    df = pd.DataFrame({
        'open'  : np.round(opens,     5),
        'high'  : np.round(highs,     5),
        'low'   : np.round(lows,      5),
        'close' : np.round(fechamentos, 5),
        'volume': volumes,
    }, index=pd.DatetimeIndex(timestamps, tz=timezone.utc))

    return df


def reamostrar(df_base: pd.DataFrame, tf_alvo_min: int) -> pd.DataFrame:
    """
    Reamestra um DataFrame de menor timeframe para um maior.
    Ex.: M5 → M15 ou M5 → H1.
    """
    regra = f'{tf_alvo_min}min'
    df_re = df_base.resample(regra).agg({
        'open'  : 'first',
        'high'  : 'max',
        'low'   : 'min',
        'close' : 'last',
        'volume': 'sum',
    }).dropna()
    return df_re


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Bot RAFI — Backtest de estratégia EURUSD'
    )
    parser.add_argument('--m5',      default=None, help='CSV com dados M5')
    parser.add_argument('--m15',     default=None, help='CSV com dados M15')
    parser.add_argument('--capital', type=float, default=None,
                        help='Capital inicial em USD (padrão: capital_inicial do config.yaml)')
    parser.add_argument('--config',  default='config.yaml',
                        help='Arquivo de configuração YAML')
    parser.add_argument('--grafico', default=None,
                        help='Caminho para salvar gráfico PNG de equity')
    parser.add_argument('--log',     default='INFO',
                        help='Nível de log: DEBUG, INFO, WARNING')
    args = parser.parse_args()

    # ── Carregar configurações ─────────────────────────────────
    with open(args.config, 'r', encoding='utf-8') as f:
        config = yaml.safe_load(f)

    # Capital: CLI > config.yaml > default 100
    capital = args.capital if args.capital is not None else float(config.get('capital_inicial', 100.0))

    log_arquivo = config.get('log_arquivo', 'logs/backtest.log')
    configurar_logging(args.log, log_arquivo)
    logger = logging.getLogger(__name__)
    logger.info("=== Bot RAFI — Iniciando backtest ===")

    # ── Carregar ou gerar dados ────────────────────────────────
    if args.m5:
        # M15 é opcional — se não fornecido, reamostrado do M5 (não usado na estratégia atual)
        if args.m15:
            logger.info(f"Carregando dados CSV: M5={args.m5}, M15={args.m15}")
        else:
            logger.info(f"Carregando dados CSV: M5={args.m5} (M15 será gerado do M5)")
        bt = BacktestCSV.de_csv(
            config,
            caminho_m5=args.m5,
            caminho_m15=args.m15 if args.m15 else args.m5,
            capital=capital,
        )
    else:
        logger.warning(
            "Arquivo CSV não fornecido. Usando dados SINTÉTICOS (apenas para teste de código)."
        )
        df_m5  = gerar_dados_sinteticos(n_candles=8640, tf_minutos=5)   # ~30 dias
        df_m15 = reamostrar(df_m5, 15)
        bt = Backtest(config, df_m5, df_m15, capital=capital)

    # ── Executar ───────────────────────────────────────────────
    trades = bt.executar()

    # ── Relatório ──────────────────────────────────────────────
    relatorio = gerar_relatorio(
        trades,
        capital_inicial=capital,
        equity_curve=bt.equity_curve,
        salvar_grafico=args.grafico,
    )

    # Verificar metas mínimas (Fase 1A)
    if relatorio.get('win_rate_pct', 0) >= 55 and relatorio.get('profit_factor', 0) >= 1.5:
        logger.info("✔ METAS DE FASE 1A ATINGIDAS: win rate ≥55% e profit factor ≥1.5")
    else:
        logger.warning("✘ Metas de Fase 1A não atingidas — revisar parâmetros")


if __name__ == '__main__':
    main()
