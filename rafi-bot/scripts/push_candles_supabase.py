"""
scripts/push_candles_supabase.py — Envia candles OHLCV para o Supabase (tabela rafi_candles)

Uso:
  py scripts/push_candles_supabase.py --arquivo data/EURUSD_semana.csv

Cria a tabela automaticamente via SQL se não existir (requer acesso ao Supabase).
Depois de rodar, o botão "Supabase (N)" aparece no Gráfico RAFI do dashboard —
clique nele para carregar os candles sem precisar transferir arquivo nenhum.

Suporta o formato tab-separado do MT5 (Date, Time, Open, High, Low, Close, Volume).
"""

import argparse
import csv
import json
import os
import sys
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

# ── Carrega .env ───────────────────────────────────────────────────────────────
for env_path in [Path('.env'), Path(__file__).parent.parent / '.env']:
    if env_path.exists():
        for linha in env_path.read_text(encoding='utf-8-sig').splitlines():
            linha = linha.strip()
            if '=' in linha and not linha.startswith('#'):
                chave, valor = linha.split('=', 1)
                os.environ.setdefault(chave.strip(), valor.strip())
        break


def _parse_mt5_row(row: dict) -> dict | None:
    """Converte uma linha do CSV MT5 em dict para o Supabase."""
    try:
        date_str = row.get('Date', '').strip()
        time_str = row.get('Time', '').strip()
        if not date_str or not time_str:
            return None

        # Formato MT5: YYYY.MM.DD HH:MM
        dt = datetime.strptime(f"{date_str} {time_str}", "%Y.%m.%d %H:%M")
        dt = dt.replace(tzinfo=timezone.utc)
        unix_time = int(dt.timestamp())

        return {
            'time'  : unix_time,
            'open'  : float(row['Open']),
            'high'  : float(row['High']),
            'low'   : float(row['Low']),
            'close' : float(row['Close']),
            'volume': float(row.get('Volume', 0) or 0),
        }
    except (KeyError, ValueError):
        return None


def _post_batch(endpoint: str, headers: dict, rows: list) -> bool:
    body = json.dumps(rows).encode('utf-8')
    req  = urllib.request.Request(endpoint, data=body, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status in (200, 201)
    except urllib.error.HTTPError as e:
        corpo = e.read().decode('utf-8', errors='replace')
        print(f"  ERRO HTTP {e.code}: {corpo[:300]}")
        return False
    except Exception as e:
        print(f"  ERRO: {e}")
        return False


def criar_tabela(url: str, key: str) -> None:
    """Tenta criar a tabela rafi_candles via Management API (se tiver service_key)."""
    service_key = os.environ.get('SUPABASE_SERVICE_KEY', '').strip()
    if not service_key:
        print("  (SUPABASE_SERVICE_KEY não configurado — pule se a tabela já existir)")
        return

    # Extrai project ref da URL (https://xxxx.supabase.co)
    ref = url.replace('https://', '').split('.')[0]
    sql_endpoint = f"https://api.supabase.com/v1/projects/{ref}/database/query"
    sql = """
    CREATE TABLE IF NOT EXISTS rafi_candles (
      time   BIGINT PRIMARY KEY,
      open   NUMERIC NOT NULL,
      high   NUMERIC NOT NULL,
      low    NUMERIC NOT NULL,
      close  NUMERIC NOT NULL,
      volume NUMERIC DEFAULT 0
    );
    ALTER TABLE rafi_candles DISABLE ROW LEVEL SECURITY;
    """
    body = json.dumps({'query': sql}).encode('utf-8')
    headers = {
        'Authorization': f'Bearer {service_key}',
        'Content-Type' : 'application/json',
    }
    req = urllib.request.Request(sql_endpoint, data=body, headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            if resp.status in (200, 201):
                print("  Tabela rafi_candles criada/verificada com sucesso")
    except Exception:
        print("  Não foi possível criar tabela via API — certifique-se que ela já existe no Supabase")


def main() -> None:
    parser = argparse.ArgumentParser(description='Envia candles OHLCV ao Supabase')
    parser.add_argument('--arquivo', default='data/EURUSD_semana.csv',
                        help='CSV MT5 tab-separado (padrão: data/EURUSD_semana.csv)')
    parser.add_argument('--batch', type=int, default=200,
                        help='Candles por requisição (padrão: 200)')
    parser.add_argument('--limpar', action='store_true',
                        help='Apaga todos os candles existentes antes de inserir')
    args = parser.parse_args()

    url = os.environ.get('SUPABASE_URL', '').strip()
    key = os.environ.get('SUPABASE_KEY', '').strip()
    if not url or not key:
        print("ERRO: SUPABASE_URL e SUPABASE_KEY devem estar no .env")
        sys.exit(1)

    arquivo = Path(args.arquivo)
    if not arquivo.exists():
        print(f"ERRO: arquivo não encontrado: {arquivo}")
        sys.exit(1)

    endpoint = f"{url.rstrip('/')}/rest/v1/rafi_candles"
    headers_upsert = {
        'apikey'       : key,
        'Authorization': f'Bearer {key}',
        'Content-Type' : 'application/json',
        'Prefer'       : 'resolution=merge-duplicates',
    }

    # Apaga registros existentes se --limpar
    if args.limpar:
        req_del = urllib.request.Request(
            f"{endpoint}?time=gt.0",
            headers={'apikey': key, 'Authorization': f'Bearer {key}'},
            method='DELETE',
        )
        try:
            urllib.request.urlopen(req_del, timeout=20)
            print("Candles anteriores apagados.")
        except Exception as e:
            print(f"Aviso ao apagar: {e}")

    # Lê o CSV
    print(f"Lendo {arquivo} ...")
    rows = []
    with open(arquivo, encoding='utf-8', newline='') as f:
        dialect = csv.Sniffer().sniff(f.read(4096))
        f.seek(0)
        reader = csv.DictReader(f, dialect=dialect)
        for r in reader:
            parsed = _parse_mt5_row(r)
            if parsed:
                rows.append(parsed)

    if not rows:
        print("ERRO: nenhum candle válido no arquivo")
        sys.exit(1)

    print(f"  {len(rows):,} candles lidos ({rows[0]['time']} → {rows[-1]['time']})")
    print(f"Enviando ao Supabase em lotes de {args.batch}...")

    enviados = 0
    for i in range(0, len(rows), args.batch):
        lote = rows[i : i + args.batch]
        ok   = _post_batch(endpoint, headers_upsert, lote)
        if ok:
            enviados += len(lote)
            pct = enviados / len(rows) * 100
            print(f"  {enviados:,}/{len(rows):,} ({pct:.0f}%)", end='\r')
        else:
            print(f"\nERRO no lote {i // args.batch + 1} — abortando")
            sys.exit(1)

    print(f"\nOK - {enviados:,} candles enviados ao Supabase (tabela rafi_candles)")
    print("Agora abra o Gráfico RAFI no dashboard — o botão 'Supabase (N)' aparecerá automaticamente.")


if __name__ == '__main__':
    main()
