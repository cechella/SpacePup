"""
baixar_dukascopy.py — Download de dados M5 EURUSD da Dukascopy Historical Data Feed

Baixa candles BID M5 para um período e salva CSV no formato padrão do autoscan_browser.py.

Uso:
  python scripts/baixar_dukascopy.py --inicio 2026-05-01 --fim 2026-08-31 --pasta data/eurusd_m5/
  python scripts/baixar_dukascopy.py --inicio 2026-08-04 --fim 2026-08-07

API pública da Dukascopy (sem autenticação):
  https://datafeed.dukascopy.com/datafeed/EURUSD/YYYY/MM(0-based)/DD/BID_candles_min_1.bi5
  Formato: bi5 (LZMA-compressed binary, 10 bytes/tick)
  Cada hora = 1 arquivo, 60 candles de 1 minuto → agrupamos em M5
"""

import argparse
import os
import struct
import lzma
import time
import math
import requests
from datetime import datetime, date, timedelta, timezone
from pathlib import Path


SYMBOL  = 'EURUSD'
POINT   = 0.00001          # 1 ponto = 0.1 pip para EURUSD
TF_MIN  = 5                # M5 = agrupar 5 candles de 1 minuto


def download_hora(ano: int, mes: int, dia: int, hora: int, sessao: requests.Session) -> list[dict]:
    """
    Baixa e descomprime 1 arquivo bi5 da Dukascopy (1 hora de dados M1).
    Retorna lista de dicts {time_utc, open, high, low, close, volume}.
    Retorna [] se o arquivo não existir (fora do horário de mercado).
    """
    # Mês na URL é 0-based
    url = (f"https://datafeed.dukascopy.com/datafeed/{SYMBOL}/"
           f"{ano:04d}/{mes-1:02d}/{dia:02d}/{hora:02d}h_BID_candles_min_1.bi5")

    try:
        r = sessao.get(url, timeout=15)
        if r.status_code == 404 or len(r.content) == 0:
            return []
        if r.status_code != 200:
            print(f"  [aviso] HTTP {r.status_code} — {url}")
            return []

        # Descomprime LZMA
        raw = lzma.decompress(r.content)
    except Exception as e:
        print(f"  [erro download] {url} — {e}")
        return []

    # Formato bi5: 10 bytes por candle M1
    # struct: >IIIIf  →  timestamp_ms (uint32), open_i (uint32), high_i (uint32), low_i (uint32), close_f (float), volume_f (float)?
    # Na verdade: >iiiff  →  time(ms desde hora), open, high, low (int×POINT×1e5), close (float), volume (float)
    # Formato exato: big-endian, 5 campos de 4 bytes cada = 20 bytes por candle
    RECORD_SIZE = 20
    candles = []
    base_ts = int(datetime(ano, mes, dia, hora, 0, 0, tzinfo=timezone.utc).timestamp()) * 1000

    for off in range(0, len(raw), RECORD_SIZE):
        chunk = raw[off:off + RECORD_SIZE]
        if len(chunk) < RECORD_SIZE:
            break
        try:
            ms_off, o_i, h_i, l_i, c_f, v_f = struct.unpack('>IIIIff', chunk)
        except struct.error:
            break

        ts_utc = (base_ts + ms_off) // 1000  # segundos UTC
        o = round(o_i * POINT, 5)
        h = round(h_i * POINT, 5)
        l = round(l_i * POINT, 5)
        c = round(c_f, 5)
        v = round(v_f, 0)
        candles.append({'time': ts_utc, 'open': o, 'high': h, 'low': l, 'close': c, 'volume': int(v)})

    return candles


def agrupar_m5(m1_candles: list[dict]) -> list[dict]:
    """Agrupa candles M1 em M5 (cada grupo de 5)."""
    if not m1_candles:
        return []
    m5 = []
    # Alinha ao múltiplo de 5 minutos
    i = 0
    while i < len(m1_candles):
        grupo = m1_candles[i:i + TF_MIN]
        if not grupo:
            break
        c = {
            'time'  : grupo[0]['time'],
            'open'  : grupo[0]['open'],
            'high'  : max(g['high']   for g in grupo),
            'low'   : min(g['low']    for g in grupo),
            'close' : grupo[-1]['close'],
            'volume': sum(g['volume'] for g in grupo),
        }
        m5.append(c)
        i += TF_MIN
    return m5


def baixar_dia(ano: int, mes: int, dia: int, sessao: requests.Session) -> list[dict]:
    """Baixa 24 horas de M1 e retorna candles M5 do dia."""
    m1_dia = []
    for hora in range(24):
        m1 = download_hora(ano, mes, dia, hora, sessao)
        m1_dia.extend(m1)
        if m1:
            time.sleep(0.1)   # respeita o servidor
    return agrupar_m5(m1_dia)


def salvar_csv(candles: list[dict], caminho: str) -> None:
    """Salva candles no formato padrão do autoscan_browser.py."""
    os.makedirs(os.path.dirname(caminho) or '.', exist_ok=True)
    with open(caminho, 'w') as f:
        f.write("time_utc,open,high,low,close,volume\n")
        for c in candles:
            dt = datetime.fromtimestamp(c['time'], tz=timezone.utc)
            f.write(f"{dt.isoformat()},{c['open']},{c['high']},{c['low']},{c['close']},{c['volume']}\n")


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Download de dados M5 EURUSD da Dukascopy Historical Feed'
    )
    parser.add_argument('--inicio', required=True,
                        help='Data inicial YYYY-MM-DD (inclusive)')
    parser.add_argument('--fim',    required=True,
                        help='Data final   YYYY-MM-DD (inclusive)')
    parser.add_argument('--pasta',  default='data/eurusd_m5',
                        help='Pasta de destino (padrão: data/eurusd_m5/)')
    parser.add_argument('--consolidar', action='store_true',
                        help='Além dos arquivos diários, grava um CSV único com todos os candles')
    args = parser.parse_args()

    dt_ini = datetime.strptime(args.inicio, '%Y-%m-%d').date()
    dt_fim = datetime.strptime(args.fim,    '%Y-%m-%d').date()

    if dt_fim < dt_ini:
        print("Erro: --fim deve ser >= --inicio"); return

    total_dias = (dt_fim - dt_ini).days + 1
    print(f"\n=== DOWNLOAD DUKASCOPY M5 — {SYMBOL} ===")
    print(f"Período : {args.inicio} → {args.fim} ({total_dias} dias calendario)")
    print(f"Pasta   : {args.pasta}/\n")

    sessao    = requests.Session()
    sessao.headers['User-Agent'] = 'Mozilla/5.0'

    todos_candles = []
    dia_atual     = dt_ini
    dias_ok       = 0

    while dia_atual <= dt_fim:
        nome_arq = os.path.join(args.pasta, f"EURUSD_M5_{dia_atual.strftime('%Y%m%d')}.csv")

        # Pula se já baixado
        if os.path.exists(nome_arq):
            print(f"  {dia_atual}  ✓ já existe, pulando")
            if args.consolidar:
                import csv
                with open(nome_arq) as f:
                    reader = csv.DictReader(f)
                    for row in reader:
                        try:
                            ts = int(datetime.fromisoformat(row['time_utc']).timestamp())
                            todos_candles.append({
                                'time': ts, 'open': float(row['open']),
                                'high': float(row['high']), 'low': float(row['low']),
                                'close': float(row['close']), 'volume': int(row.get('volume',0))
                            })
                        except: pass
            dia_atual += timedelta(days=1)
            continue

        # Final de semana (sábado=5, domingo=6) — Dukascopy não tem dados
        if dia_atual.weekday() >= 5:
            print(f"  {dia_atual}  — final de semana, pulando")
            dia_atual += timedelta(days=1)
            continue

        print(f"  {dia_atual}  baixando...", end=' ', flush=True)
        candles_dia = baixar_dia(dia_atual.year, dia_atual.month, dia_atual.day, sessao)

        if candles_dia:
            salvar_csv(candles_dia, nome_arq)
            print(f"{len(candles_dia)} candles M5 → {nome_arq}")
            todos_candles.extend(candles_dia)
            dias_ok += 1
        else:
            print(f"0 candles (feriado ou sem dados)")

        dia_atual += timedelta(days=1)

    print(f"\nTotal: {dias_ok} dias baixados, {len(todos_candles)} candles M5")

    if args.consolidar and todos_candles:
        todos_candles.sort(key=lambda c: c['time'])
        consolidado = os.path.join(args.pasta, f"EURUSD_M5_{args.inicio}_{args.fim}_consolidado.csv")
        salvar_csv(todos_candles, consolidado)
        print(f"Consolidado: {consolidado}")

    print("\nPróximo passo:")
    print(f"  python scripts/autoscan_browser.py --dir {args.pasta}/ --semanal")


if __name__ == '__main__':
    main()
