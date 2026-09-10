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
import hashlib
import logging
import os
import sys
import yaml
import numpy as np
import pandas as pd
from datetime import datetime, timedelta, timezone

# Carrega variáveis de ambiente do .env (SUPABASE_URL, SUPABASE_KEY)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass  # dotenv opcional — usa variáveis de ambiente do sistema se existirem

# Adiciona o diretório raiz ao path para importações relativas
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from backtest.engine import Backtest, BacktestCSV
from backtest.report import gerar_relatorio, exportar_csv_detalhado


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
    parser.add_argument('--csv',     default=None,
                        help='Salvar lista de trades em CSV (ex: logs/trades.csv)')
    parser.add_argument('--supabase', action='store_true',
                        help='Busca parâmetros do Simulador no Supabase (override do config.yaml)')
    parser.add_argument('--storage', action='store_true',
                        help='Baixa o CSV de dados do Supabase Storage antes do backtest '
                             '(requer SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY)')
    parser.add_argument('--broker-storage', default='pepperstone',
                        dest='broker_storage',
                        help='Corretora cujos dados serão baixados do Storage (default: pepperstone)')
    parser.add_argument('--inicio', default=None,
                        help='Data inicial do backtest (YYYY-MM-DD). Ex: 2026-08-01')
    parser.add_argument('--fim',    default=None,
                        help='Data final do backtest (YYYY-MM-DD). Ex: 2026-08-31')
    parser.add_argument('--rr', type=float, default=None,
                        help='Override ratio_risco_retorno. Ex: 3.0 ou 4.0')
    parser.add_argument('--spread', type=float, default=None,
                        help='Override spread_pips. Ex: 0.1 (Razor) ou 0.2 (Standard)')
    parser.add_argument('--slippage', type=float, default=None,
                        help='Override slippage_pips base. Ex: 0.3')
    parser.add_argument('--comissao', type=float, default=None,
                        help='Override comissao_por_lote RT. Ex: 6.0 (Razor) ou 7.0 (Exness Raw)')
    parser.add_argument('--slippage-escalonado', action='store_true', dest='slippage_escalonado',
                        help='Ativa slippage extra por tamanho de lote (realismo em lotes grandes)')
    parser.add_argument('--nome-corretora', default=None, dest='nome_corretora',
                        help='Nome da corretora para identificação no relatório. Ex: Pepperstone')
    args = parser.parse_args()

    # ── Carregar configurações ─────────────────────────────────
    with open(args.config, 'rb') as f:
        _raw = f.read()
    config = yaml.safe_load(_raw.decode('utf-8'))

    # ── Override via Supabase (perfil 'simulator') ─────────────
    # Usa os parâmetros salvos no admin dashboard como fallback/override.
    # Campos mapeados: todos os keys de rafi_bot_config que existem no config.yaml.
    if args.supabase:
        url = os.environ.get('SUPABASE_URL', '')
        key = os.environ.get('SUPABASE_KEY', '')
        if not url or not key:
            print("⚠  SUPABASE_URL / SUPABASE_KEY não encontrados no .env — usando config.yaml")
        else:
            try:
                from supabase import create_client
                sb = create_client(url, key)
                resp = sb.table('rafi_bot_config').select('*').eq('profile', 'simulator').single().execute()
                row = resp.data or {}
                # Campos que o bot Python reconhece diretamente pelo mesmo nome
                CAMPOS_MAPEADOS = [
                    'estrategia_modo', 'forca_limiar', 'rafi_periodo',
                    'sr_lookback', 'swing_stop_lookback',
                    'ma_rapida', 'ma_lenta', 'ma_threshold',
                    'bb_filtro_ativo', 'bb_limiar_estreita', 'bb_periodo', 'bb_desvios',
                    # parâmetros exclusivos do modo autoscan — devem espelhar executor.py MAPA
                    'autoscan_min_breakout', 'autoscan_min_gap_candles',
                    'autoscan_stop_offset', 'autoscan_sr_lookback',
                    'bb_squeeze_expansao_min',
                    # gestão de risco
                    'ratio_risco_retorno', 'max_trades_simultaneos',
                    'risco_por_trade', 'risco_maximo_diario',
                    'modo_lote', 'max_losses_seguidos',
                ]
                sobrescritos = []
                for k in CAMPOS_MAPEADOS:
                    if k in row and row[k] is not None:
                        config[k] = row[k]
                        sobrescritos.append(f"{k}={row[k]}")
                print(f"✔  Config do Supabase (Simulador): {', '.join(sobrescritos) if sobrescritos else 'nenhum campo novo'}")
            except Exception as e:
                print(f"⚠  Falha ao buscar Supabase: {e} — usando config.yaml")

    # Hash MD5 (8 chars) do config.yaml — identifica a versão de parâmetros
    # usada neste backtest, permitindo comparar resultados entre runs
    config_hash = hashlib.md5(_raw).hexdigest()[:8]
    logger_tmp = logging.getLogger(__name__)

    # Capital: CLI > config.yaml > default 100
    capital = args.capital if args.capital is not None else float(config.get('capital_inicial', 100.0))

    # R:R: CLI > config.yaml
    if args.rr is not None:
        config['ratio_risco_retorno'] = args.rr

    # Custos por corretora: CLI > config.yaml
    if args.spread   is not None: config['spread_pips']        = args.spread
    if args.slippage is not None: config['slippage_pips']       = args.slippage
    if args.comissao is not None: config['comissao_por_lote']   = args.comissao
    if args.slippage_escalonado:  config['slippage_escalonado'] = True

    log_arquivo = config.get('log_arquivo', 'logs/backtest.log')
    configurar_logging(args.log, log_arquivo)
    logger = logging.getLogger(__name__)
    nome_corretora = args.nome_corretora or 'N/A'
    logger.info(f"=== Bot RAFI — Iniciando backtest | Corretora: {nome_corretora} ===")
    logger.info(f"Config hash: {config_hash} (arquivo: {args.config})")

    # ── Download automático do Supabase Storage ───────────────
    # Se --storage for passado, baixa o CSV da Pepperstone (ou outro broker)
    # antes de qualquer coisa. O caminho baixado sobrescreve --m5 se não
    # tiver sido informado explicitamente.
    if args.storage:
        broker_dl = args.broker_storage
        caminho_dl = os.path.join(
            os.path.dirname(os.path.abspath(args.config)),
            'data', f'{broker_dl}_EURUSD_M5.csv',
        )
        logger.info(f"[Storage] Iniciando download automático: {broker_dl}")
        try:
            from src.supabase_sync import baixar_dados_storage
            ok = baixar_dados_storage(broker=broker_dl, destino=caminho_dl)
        except Exception as e:
            ok = False
            logger.error(f"[Storage] Erro ao importar supabase_sync: {e}")
        if not ok:
            logger.error("[Storage] Download falhou — abortando backtest")
            sys.exit(1)
        if not args.m5:
            args.m5 = caminho_dl
            logger.info(f"[Storage] Usando dados baixados: {args.m5}")

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

    # ── Filtro de período (--inicio / --fim) ──────────────────
    if args.inicio or args.fim:
        dt_inicio = pd.Timestamp(args.inicio, tz='UTC') if args.inicio else bt.df_m5.index.min()
        dt_fim    = pd.Timestamp(args.fim,    tz='UTC') if args.fim    else bt.df_m5.index.max()
        # Estende fim até o final do dia
        dt_fim    = dt_fim + pd.Timedelta(hours=23, minutes=59)
        bt.df_m5  = bt.df_m5.loc[dt_inicio:dt_fim]
        bt.df_m15 = bt.df_m15.loc[dt_inicio:dt_fim]
        logger.info(f"Período filtrado: {dt_inicio.date()} → {dt_fim.date()} "
                    f"({len(bt.df_m5):,} candles M5)")

    # ── Executar ───────────────────────────────────────────────
    trades = bt.executar()

    # ── Relatório ──────────────────────────────────────────────
    relatorio = gerar_relatorio(
        trades,
        capital_inicial=capital,
        equity_curve=bt.equity_curve,
        salvar_grafico=args.grafico,
    )

    # Exportar trades para CSV detalhado (inclui RAFI, BB, S/R, sessão, hash do config)
    if args.csv and trades:
        exportar_csv_detalhado(trades, args.csv, config_hash=config_hash)
        logger.info(f"CSV detalhado: {args.csv} | Config hash: {config_hash}")

    # Verificar metas mínimas (Fase 1A)
    if relatorio.get('win_rate_pct', 0) >= 55 and relatorio.get('profit_factor', 0) >= 1.5:
        logger.info("✔ METAS DE FASE 1A ATINGIDAS: win rate ≥55% e profit factor ≥1.5")
    else:
        logger.warning("✘ Metas de Fase 1A não atingidas — revisar parâmetros")


if __name__ == '__main__':
    main()
