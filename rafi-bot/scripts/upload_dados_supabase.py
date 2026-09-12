"""
Script VPS: comprime e envia dados históricos EURUSD M5 para o Supabase Storage.

Uso manual no VPS:
  cd C:\\SpacePup\\rafi-bot
  set SUPABASE_URL=https://xxxx.supabase.co
  set SUPABASE_SERVICE_ROLE_KEY=eyJ...
  py scripts\\upload_dados_supabase.py
  py scripts\\upload_dados_supabase.py --arquivo data\\EURUSD_M5.csv --broker pepperstone

Variáveis de ambiente obrigatórias:
  SUPABASE_URL              — URL do projeto Supabase
  SUPABASE_SERVICE_ROLE_KEY — chave service_role (não use a anon key)

O arquivo CSV é comprimido com gzip antes do upload (~8-12 MB vs 100 MB original).
Após o upload o arquivo fica em:
  Bucket: backtest-data
  Path:   pepperstone_EURUSD_M5.csv.gz
"""

import argparse
import gzip
import io
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERRO: 'requests' não instalado. Execute: pip install requests")
    sys.exit(1)

# ── Constantes ────────────────────────────────────────────────────────────────

BUCKET_NAME = 'backtest-data'


# ── Supabase helpers ──────────────────────────────────────────────────────────

def _get_env() -> tuple[str, str]:
    url = os.environ.get('SUPABASE_URL', '').rstrip('/')
    key = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
    if not url:
        raise RuntimeError(
            "Variável de ambiente SUPABASE_URL não definida.\n"
            "Execute: set SUPABASE_URL=https://xxxx.supabase.co"
        )
    if not key:
        raise RuntimeError(
            "Variável de ambiente SUPABASE_SERVICE_ROLE_KEY não definida.\n"
            "Execute: set SUPABASE_SERVICE_ROLE_KEY=eyJ..."
        )
    return url, key


def _headers(key: str) -> dict:
    return {
        'apikey':        key,
        'Authorization': f'Bearer {key}',
    }


# ── Tabela rafi_uploads ───────────────────────────────────────────────────────

def _atualizar_status(url: str, key: str, upload_id: str, **campos) -> None:
    """Atualiza campos da linha em rafi_uploads."""
    campos['updated_at'] = datetime.now(timezone.utc).isoformat()
    res = requests.patch(
        f'{url}/rest/v1/rafi_uploads?id=eq.{upload_id}',
        headers={
            **_headers(key),
            'Content-Type': 'application/json',
            'Prefer':       'return=minimal',
        },
        json=campos,
        timeout=15,
    )
    if res.status_code not in (200, 204):
        print(f"[WARN] Não foi possível atualizar rafi_uploads: {res.status_code} {res.text[:200]}")


def _inserir_upload(url: str, key: str, nome_arquivo: str, broker: str) -> str:
    """Insere nova linha em rafi_uploads e retorna o UUID gerado."""
    payload = {
        'arquivo':      nome_arquivo,
        'broker':       broker,
        'status':       'running',
        'progress_pct': 0,
    }
    res = requests.post(
        f'{url}/rest/v1/rafi_uploads',
        headers={
            **_headers(key),
            'Content-Type': 'application/json',
            'Prefer':       'return=representation',
        },
        json=payload,
        timeout=15,
    )
    if res.status_code not in (200, 201):
        raise RuntimeError(
            f"Erro ao criar linha em rafi_uploads: {res.status_code}\n{res.text[:400]}"
        )
    data = res.json()
    row  = data[0] if isinstance(data, list) else data
    return row['id']


# ── Compressão gzip ───────────────────────────────────────────────────────────

def _comprimir_csv(caminho: Path) -> tuple[bytes, int]:
    """
    Lê o CSV e comprime com gzip nível 6.

    Retorna (bytes_gz, tamanho_original_em_bytes).
    Imprime progresso a cada 10 MB lido.
    """
    tamanho = caminho.stat().st_size
    print(f"\nComprimindo {caminho.name} ({tamanho / 1024 / 1024:.1f} MB)...")

    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode='wb', compresslevel=6) as gz:
        with open(caminho, 'rb') as f:
            lido = 0
            ultimo_log = 0
            while True:
                chunk = f.read(4 * 1024 * 1024)   # 4 MB por vez
                if not chunk:
                    break
                gz.write(chunk)
                lido += len(chunk)
                if lido - ultimo_log >= 10 * 1024 * 1024:
                    pct = int(lido / tamanho * 100)
                    print(f"  {lido / 1024 / 1024:.0f} / {tamanho / 1024 / 1024:.0f} MB ({pct}%)")
                    ultimo_log = lido

    gz_bytes = buf.getvalue()
    razao    = tamanho / len(gz_bytes)
    print(f"  Concluído: {len(gz_bytes) / 1024 / 1024:.1f} MB (compressão {razao:.1f}x)")
    return gz_bytes, tamanho


# ── Upload para o Supabase Storage ────────────────────────────────────────────

def _upload_storage(
    url:       str,
    key:       str,
    nome_gcs:  str,
    dados_gz:  bytes,
    upload_id: str,
) -> str:
    """
    Envia os bytes gzip para o Supabase Storage (upsert).

    Retorna o storage_path final (ex: 'pepperstone_EURUSD_M5.csv.gz').
    """
    storage_path = nome_gcs
    endpoint     = f'{url}/storage/v1/object/{BUCKET_NAME}/{storage_path}'
    tamanho_mb   = len(dados_gz) / 1024 / 1024

    print(f"\nEnviando {storage_path} ({tamanho_mb:.1f} MB) para Supabase Storage...")
    _atualizar_status(url, key, upload_id, status='running', progress_pct=55)

    # POST com x-upsert para sobrescrever se já existir
    res = requests.post(
        endpoint,
        headers={
            **_headers(key),
            'Content-Type': 'application/gzip',
            'x-upsert':     'true',
        },
        data=dados_gz,
        timeout=600,   # arquivo grande — até 10 minutos
    )

    if res.status_code not in (200, 201):
        # Fallback: tenta PUT direto
        res = requests.put(
            f'{url}/storage/v1/object/{BUCKET_NAME}/{storage_path}',
            headers={**_headers(key), 'Content-Type': 'application/gzip'},
            data=dados_gz,
            timeout=600,
        )

    if res.status_code not in (200, 201):
        raise RuntimeError(
            f"Erro no upload Storage: HTTP {res.status_code}\n{res.text[:400]}"
        )

    return storage_path


# ── Ponto de entrada ──────────────────────────────────────────────────────────

def main() -> int:
    parser = argparse.ArgumentParser(
        description='Comprime e envia dados EURUSD M5 para o Supabase Storage'
    )
    parser.add_argument(
        '--arquivo', default=r'data\EURUSD_M5.csv',
        help='Caminho para o CSV (padrão: data\\EURUSD_M5.csv)',
    )
    parser.add_argument(
        '--broker', default='pepperstone',
        help='Nome da corretora (padrão: pepperstone)',
    )
    parser.add_argument(
        '--upload-id', default=None,
        help='UUID de uma linha existente em rafi_uploads (quando chamado pelo executor)',
    )
    args = parser.parse_args()

    caminho = Path(args.arquivo)
    if not caminho.exists():
        # Tenta caminho relativo à raiz do rafi-bot
        alt = Path(__file__).parent.parent / args.arquivo
        if alt.exists():
            caminho = alt
        else:
            print(f"ERRO: Arquivo não encontrado: {args.arquivo}")
            return 1

    print(f"Arquivo: {caminho.resolve()}")
    print(f"Broker:  {args.broker}")

    try:
        url, key = _get_env()
    except RuntimeError as exc:
        print(f"ERRO: {exc}")
        return 1

    upload_id = args.upload_id
    try:
        # Cria ou reutiliza linha em rafi_uploads
        if not upload_id:
            nome_exibicao = f'{args.broker}_{caminho.stem}.csv.gz'
            upload_id = _inserir_upload(url, key, nome_exibicao, args.broker)
            print(f"Upload ID: {upload_id}")
        else:
            _atualizar_status(url, key, upload_id, status='running', progress_pct=5)

        # 1. Comprimir
        dados_gz, tamanho_original = _comprimir_csv(caminho)
        _atualizar_status(url, key, upload_id, progress_pct=45)

        # 2. Upload (nome: broker_EURUSD_M5.csv.gz)
        nome_gcs     = f'{args.broker}_{caminho.stem}.csv.gz'
        storage_path = _upload_storage(url, key, nome_gcs, dados_gz, upload_id)

        # 3. Marca como concluído
        _atualizar_status(
            url, key, upload_id,
            status='done',
            progress_pct=100,
            storage_path=storage_path,
            tamanho_bytes=tamanho_original,
        )
        print(f"\n✓ Sucesso! Arquivo disponível em: {BUCKET_NAME}/{storage_path}")
        print(  "  Para usar no backtest, baixe de:")
        print(  f"  {url}/storage/v1/object/public/{BUCKET_NAME}/{storage_path}")
        return 0

    except Exception as exc:
        print(f"\nERRO: {exc}")
        if upload_id:
            _atualizar_status(url, key, upload_id, status='error', error_msg=str(exc)[:500])
        return 1


if __name__ == '__main__':
    sys.exit(main())
