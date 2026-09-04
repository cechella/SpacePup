#!/usr/bin/env python3
"""
processar_histdata.py — Converte dados do HistData.com (M1) para M5

USO:
  1. Baixe os ZIPs de EURUSD M1 do histdata.com (formato ASCII ou MetaTrader)
  2. Coloque os ZIPs (ou CSVs extraídos) em rafi-bot/data/histdata/
  3. Execute: python scripts/processar_histdata.py

SAÍDA: rafi-bot/data/EURUSD_M5_8anos.csv  (formato tab-separado, pronto pro bot)

Formatos suportados do HistData.com:
  - ASCII:      YYYYMMDD,HHMMSS,O,H,L,C,V  (sem cabeçalho)
  - MetaTrader: mesmo formato acima
"""

import os
import sys
import zipfile
import glob
import pandas as pd
from pathlib import Path

# ── Diretórios ──────────────────────────────────────────────────────────────
BASE_DIR  = Path(__file__).resolve().parent.parent
DATA_DIR  = BASE_DIR / 'data'
INPUT_DIR = DATA_DIR / 'histdata'
OUTPUT    = DATA_DIR / 'EURUSD_M5_8anos.csv'


def extrair_zips(pasta: Path):
    """Extrai todos os ZIPs encontrados na pasta."""
    zips = list(pasta.glob('*.zip')) + list(pasta.glob('*.ZIP'))
    if not zips:
        return
    print(f"Extraindo {len(zips)} arquivo(s) ZIP...")
    for z in zips:
        print(f"  → {z.name}")
        with zipfile.ZipFile(z, 'r') as zf:
            zf.extractall(pasta)
    print("Extração concluída.\n")


def ler_csv_histdata(path: Path) -> pd.DataFrame | None:
    """
    Lê um CSV do HistData.com (M1) e retorna DataFrame com colunas
    padronizadas: datetime (index), open, high, low, close, volume.

    Formatos tentados:
      1. YYYYMMDD,HHMMSS,O,H,L,C,V  (ASCII padrão, sem header)
      2. Com header Date,Time,Open,High,Low,Close,Volume
    """
    try:
        # Tenta ler sem cabeçalho (formato ASCII padrão)
        df = pd.read_csv(
            path,
            header=None,
            names=['date', 'time', 'open', 'high', 'low', 'close', 'volume'],
            dtype={'date': str, 'time': str},
        )

        # Verifica se primeira linha é cabeçalho textual
        if df['date'].iloc[0].upper() in ('DATE', 'YYYYMMDD', 'DATETIME'):
            df = df.iloc[1:].reset_index(drop=True)

        # Combina date + time → datetime
        # HistData usa YYYYMMDD e HHMMSS (6 dígitos, ex: 170100 = 17:01:00)
        df['datetime'] = pd.to_datetime(
            df['date'].str.strip() + df['time'].str.strip().str.zfill(6),
            format='%Y%m%d%H%M%S',
            utc=True,
        )

        df = df[['datetime', 'open', 'high', 'low', 'close', 'volume']].copy()
        df[['open', 'high', 'low', 'close', 'volume']] = \
            df[['open', 'high', 'low', 'close', 'volume']].apply(pd.to_numeric, errors='coerce')
        df.dropna(inplace=True)
        df.set_index('datetime', inplace=True)
        df.sort_index(inplace=True)
        return df

    except Exception as e:
        print(f"    ERRO ao ler {path.name}: {e}")
        return None


def m1_para_m5(df_m1: pd.DataFrame) -> pd.DataFrame:
    """Reamostrar candles M1 → M5."""
    df_m5 = df_m1.resample('5min').agg({
        'open':   'first',
        'high':   'max',
        'low':    'min',
        'close':  'last',
        'volume': 'sum',
    }).dropna()
    return df_m5


def main():
    if not INPUT_DIR.exists():
        print(f"Pasta não encontrada: {INPUT_DIR}")
        print("Crie a pasta rafi-bot/data/histdata/ e coloque os ZIPs lá.")
        sys.exit(1)

    # Extrai ZIPs
    extrair_zips(INPUT_DIR)

    # Encontra todos os CSVs (recursivo)
    csvs = sorted(INPUT_DIR.rglob('*.csv')) + sorted(INPUT_DIR.rglob('*.CSV')) + \
           sorted(INPUT_DIR.rglob('*.dat')) + sorted(INPUT_DIR.rglob('*.DAT'))

    if not csvs:
        print("Nenhum CSV encontrado em", INPUT_DIR)
        print("Verifique se os ZIPs foram baixados corretamente.")
        sys.exit(1)

    print(f"Encontrados {len(csvs)} arquivo(s) para processar:\n")

    frames = []
    total_m1 = 0

    for csv_path in csvs:
        print(f"  Lendo: {csv_path.name}")
        df = ler_csv_histdata(csv_path)
        if df is None or df.empty:
            print(f"    → ignorado (vazio ou formato inválido)")
            continue

        total_m1 += len(df)
        inicio = df.index[0].strftime('%d/%m/%Y')
        fim    = df.index[-1].strftime('%d/%m/%Y')
        print(f"    → {len(df):,} candles M1  |  {inicio} → {fim}")

        df_m5 = m1_para_m5(df)
        print(f"    → {len(df_m5):,} candles M5 após resample")
        frames.append(df_m5)

    if not frames:
        print("\nNenhum dado válido encontrado. Verifique o formato dos arquivos.")
        sys.exit(1)

    # Une todos os anos e remove duplicatas
    print(f"\nUnindo {len(frames)} período(s)...")
    df_total = pd.concat(frames)
    df_total = df_total[~df_total.index.duplicated(keep='last')]
    df_total.sort_index(inplace=True)

    total_m5 = len(df_total)
    inicio_total = df_total.index[0].strftime('%d/%m/%Y %H:%M')
    fim_total    = df_total.index[-1].strftime('%d/%m/%Y %H:%M')

    print(f"\n{'═'*60}")
    print(f"  Candles M1 processados : {total_m1:,}")
    print(f"  Candles M5 gerados     : {total_m5:,}")
    print(f"  Período                : {inicio_total} → {fim_total}")
    print(f"{'═'*60}")

    # Salva no formato tab-separado (mesmo formato dos outros CSVs do projeto)
    df_total.index = df_total.index.tz_convert(None)  # remove timezone p/ compatibilidade
    df_total.index.name = 'Time'
    df_total.columns = ['Open', 'High', 'Low', 'Close', 'Volume']

    df_total.to_csv(OUTPUT, sep='\t', float_format='%.5f')

    print(f"\n✓ Arquivo salvo: {OUTPUT}")
    print(f"  Tamanho: {OUTPUT.stat().st_size / 1_048_576:.1f} MB")
    print(f"\nPróximo passo:")
    print(f"  python scripts/autoscan_browser.py --csv data/EURUSD_M5_8anos.csv")
    print(f"  python scripts/otimizar_params.py --csv data/EURUSD_M5_8anos.csv --aplicar")


if __name__ == '__main__':
    main()
