"""
scripts/baixar_dados.py — Baixa histórico EURUSD# do MT5 e salva em CSV

Uso:
  python scripts/baixar_dados.py

Requisitos:
  - MetaTrader 5 aberto e conectado à conta XM
  - pip install MetaTrader5 pandas

Saída:
  data/EURUSD_M5.csv   — dados M5 (de 2023-01-01 até hoje)
"""

import sys
import os
from datetime import datetime, timezone
import pandas as pd

try:
    import MetaTrader5 as mt5
except ImportError:
    print("ERRO: biblioteca MetaTrader5 não instalada.")
    print("Execute: pip install MetaTrader5")
    sys.exit(1)

# ── Configuração ─────────────────────────────────────────────
# XM usa EURUSD# com hashtag — NÃO usar "EURUSD" sem hashtag na XM
PAR        = "EURUSD#"
DATA_INICIO = datetime(2023, 1, 1, tzinfo=timezone.utc)   # início fixo para ~300+ trades
PASTA      = os.path.join(os.path.dirname(__file__), '..', 'data')
ARQUIVO_M5 = os.path.join(PASTA, "EURUSD_M5.csv")


def inicializar_mt5() -> bool:
    """Inicializa conexão com o terminal MT5."""
    if not mt5.initialize():
        print(f"ERRO ao inicializar MT5: {mt5.last_error()}")
        return False
    info = mt5.terminal_info()
    conta = mt5.account_info()
    print(f"MT5 conectado: {info.name} | Conta: {conta.login} | Servidor: {conta.server}")
    return True


def baixar_timeframe(par: str, timeframe, nome: str, arquivo: str,
                     data_inicio: datetime) -> bool:
    """
    Baixa dados históricos do MT5 e salva em CSV no formato esperado pelo backtest.

    Formato de saída (tab-separated):
      Date\tTime\tOpen\tHigh\tLow\tClose\tVolume
    """
    data_fim = datetime.now(tz=timezone.utc)

    print(f"Baixando {par} {nome}: {data_inicio.date()} → {data_fim.date()} ...")

    rates = mt5.copy_rates_range(par, timeframe, data_inicio, data_fim)

    if rates is None or len(rates) == 0:
        print(f"ERRO: sem dados para {par} {nome}. Erro MT5: {mt5.last_error()}")
        return False

    df = pd.DataFrame(rates)
    df['time'] = pd.to_datetime(df['time'], unit='s', utc=True)

    # Separar data e hora (formato padrão de exportação MT5)
    df['Date'] = df['time'].dt.strftime('%Y.%m.%d')
    df['Time'] = df['time'].dt.strftime('%H:%M')

    df = df.rename(columns={
        'open' : 'Open',
        'high' : 'High',
        'low'  : 'Low',
        'close': 'Close',
        'tick_volume': 'Volume',
    })

    colunas = ['Date', 'Time', 'Open', 'High', 'Low', 'Close', 'Volume']
    df[colunas].to_csv(arquivo, sep='\t', index=False)

    print(f"  Salvo: {arquivo}")
    print(f"  Candles: {len(df):,} | Período: {df['Date'].iloc[0]} → {df['Date'].iloc[-1]}")
    return True


def main():
    os.makedirs(PASTA, exist_ok=True)

    if not inicializar_mt5():
        sys.exit(1)

    # Verificar se o par existe
    info_par = mt5.symbol_info(PAR)
    if info_par is None:
        print(f"ERRO: par {PAR} não encontrado no MT5. Verifique o Market Watch.")
        mt5.shutdown()
        sys.exit(1)

    # Ativar o símbolo se necessário
    if not info_par.visible:
        mt5.symbol_select(PAR, True)

    # Baixar M5 — início fixo em 2023-01-01 para cobrir ~300+ trades no backtest
    ok = baixar_timeframe(PAR, mt5.TIMEFRAME_M5, "M5", ARQUIVO_M5, DATA_INICIO)

    mt5.shutdown()

    if ok:
        print("\nPronto! Para rodar o backtest:")
        print(f"  python run_backtest.py --m5 data\\EURUSD_M5.csv --capital 20")
    else:
        print("\nErro ao baixar dados. Verifique se o MT5 está conectado.")
        sys.exit(1)


if __name__ == '__main__':
    main()
