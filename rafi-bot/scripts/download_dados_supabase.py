"""
download_dados_supabase.py — Baixa CSV de dados históricos do Supabase Storage

Uso:
  py scripts\download_dados_supabase.py
  py scripts\download_dados_supabase.py --broker pepperstone --destino data\EURUSD_M5.csv

Variáveis de ambiente necessárias:
  SUPABASE_URL              = https://xxxx.supabase.co
  SUPABASE_SERVICE_ROLE_KEY = eyJhbGci...  (chave service_role — não a anon)

O arquivo é salvo descomprimido em --destino.
Após o download, rode o backtest normalmente:
  py run_backtest.py --m5 data\EURUSD_M5.csv --capital 20 --rr 1.3
"""

import argparse
import gzip
import logging
import os
import shutil
import sys

# Tenta carregar .env antes de tudo
try:
    from dotenv import load_dotenv
    load_dotenv(os.path.join(os.path.dirname(__file__), '..', '.env'))
except ImportError:
    pass

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)s | %(message)s',
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger(__name__)


def _baixar(url_base: str, key: str, broker: str, destino: str) -> bool:
    """Faz download do gzip e descomprime para `destino`."""
    try:
        import requests
    except ImportError:
        logger.error("'requests' não instalado — execute: py -m pip install requests")
        return False

    caminho_storage = f"{broker}_EURUSD_M5.csv.gz"
    url_download    = f"{url_base.rstrip('/')}/storage/v1/object/backtest-data/{caminho_storage}"
    headers         = {
        'Authorization': f'Bearer {key}',
        'apikey':        key,
    }

    os.makedirs(os.path.dirname(os.path.abspath(destino)), exist_ok=True)
    caminho_gz = destino + '.gz'

    logger.info(f"Conectando ao Supabase Storage: {url_download}")

    resp = requests.get(url_download, headers=headers, stream=True, timeout=300)
    if resp.status_code != 200:
        logger.error(f"Erro HTTP {resp.status_code}: {resp.text[:400]}")
        return False

    tamanho_total = int(resp.headers.get('content-length', 0))
    baixado = 0

    logger.info(f"Baixando {caminho_storage}  ({tamanho_total/1e6:.1f} MB comprimido)…")
    with open(caminho_gz, 'wb') as f:
        for chunk in resp.iter_content(chunk_size=4 * 1024 * 1024):
            if chunk:
                f.write(chunk)
                baixado += len(chunk)
                if tamanho_total:
                    pct = baixado / tamanho_total * 100
                    print(f"  {baixado/1e6:.1f} MB  ({pct:.0f}%)", end='\r', flush=True)

    print()
    logger.info(f"Download concluído: {baixado/1e6:.1f} MB — descomprimindo…")

    with gzip.open(caminho_gz, 'rb') as gz_in, open(destino, 'wb') as csv_out:
        shutil.copyfileobj(gz_in, csv_out)

    tamanho_csv = os.path.getsize(destino)
    logger.info(f"✓ CSV pronto: {destino}  ({tamanho_csv/1e6:.1f} MB)")
    return True


def main() -> None:
    parser = argparse.ArgumentParser(
        description='Download de dados históricos do Supabase Storage'
    )
    parser.add_argument('--broker',  default='pepperstone',
                        help='Identificador da corretora (default: pepperstone)')
    parser.add_argument('--destino', default=None,
                        help='Caminho de destino do CSV (default: data/<broker>_EURUSD_M5.csv)')
    args = parser.parse_args()

    url_base = os.getenv('SUPABASE_URL', '')
    key      = os.getenv('SUPABASE_SERVICE_ROLE_KEY', '') or os.getenv('SUPABASE_KEY', '')

    if not url_base or 'xxxx' in url_base:
        logger.error("SUPABASE_URL não configurada.\n"
                     "  PowerShell: $env:SUPABASE_URL = 'https://xxxx.supabase.co'")
        sys.exit(1)

    if not key:
        logger.error("SUPABASE_SERVICE_ROLE_KEY não configurada.\n"
                     "  PowerShell: $env:SUPABASE_SERVICE_ROLE_KEY = 'eyJhbGci...'")
        sys.exit(1)

    # Destino padrão relativo à raiz do rafi-bot
    raiz = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
    destino = args.destino or os.path.join(raiz, 'data', f'{args.broker}_EURUSD_M5.csv')

    ok = _baixar(url_base, key, args.broker, destino)

    if ok:
        print("\n📥  Dados prontos! Rode o backtest com:")
        print(f"   py run_backtest.py --m5 {destino} --capital 20 --rr 1.3")
    else:
        logger.error("Download falhou. Verifique as credenciais e tente novamente.")
        sys.exit(1)


if __name__ == '__main__':
    main()
