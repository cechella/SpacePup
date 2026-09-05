"""
scripts/push_supabase.py — Envia trades do JSON para o Supabase (tabela rafi_trades)

Uso:
  py scripts/push_supabase.py --arquivo data/rafi-trade-log.json

Requisitos:
  - .env com SUPABASE_URL e SUPABASE_KEY no diretório raiz do projeto
  - Tabela rafi_trades existente no Supabase (criar via scripts/criar_tabelas_supabase.py)

O script usa upsert (insert or replace by id), então pode ser rodado várias vezes
sem duplicar trades — idempotente.
"""

import argparse
import json
import os
import sys
import urllib.request
import urllib.error
from pathlib import Path

# ── Carrega .env (suporte a BOM do PowerShell) ─────────────────────────────────
for env_path in [Path('.env'), Path(__file__).parent.parent / '.env']:
    if env_path.exists():
        for linha in env_path.read_text(encoding='utf-8-sig').splitlines():
            linha = linha.strip()
            if '=' in linha and not linha.startswith('#'):
                chave, valor = linha.split('=', 1)
                os.environ.setdefault(chave.strip(), valor.strip())
        break


def _camel_to_row(t: dict) -> dict:
    """Converte o formato ManualTrade (camelCase) para colunas do Supabase (snake_case)."""
    from datetime import datetime, timezone
    return {
        'id'         : t['id'],
        'direction'  : t['direction'],
        'entry'      : t['entry'],
        'stop_loss'  : t['stopLoss'],
        'take_profit': t['takeProfit'],
        'label'      : t.get('label', ''),
        'time'       : t['time'],
        'lot'        : t['lot'],
        'leverage'   : t.get('leverage', 1000),
        'result'     : t.get('result', 'pending'),
        'rafi'       : t.get('rafi'),
        'rafi_dir'   : t.get('rafiDir'),
        'bb_width'   : t.get('bbWidth'),
        'snapshot'   : t.get('snapshot'),
        'updated_at' : datetime.now(timezone.utc).isoformat(),
    }


def push_trades(url: str, key: str, trades: list[dict], batch: int = 50) -> int:
    """
    Envia trades em lotes para o Supabase via REST API (upsert).
    Retorna o número total de trades enviados com sucesso.
    """
    endpoint = f"{url.rstrip('/')}/rest/v1/rafi_trades"
    headers = {
        'apikey'       : key,
        'Authorization': f'Bearer {key}',
        'Content-Type' : 'application/json',
        'Prefer'       : 'resolution=merge-duplicates',  # upsert by id
    }

    rows = [_camel_to_row(t) for t in trades]
    enviados = 0

    for i in range(0, len(rows), batch):
        lote = rows[i : i + batch]
        body = json.dumps(lote).encode('utf-8')
        req  = urllib.request.Request(endpoint, data=body, headers=headers, method='POST')
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                status = resp.status
                if status in (200, 201):
                    enviados += len(lote)
                    print(f"  Lote {i // batch + 1}: {len(lote)} trades enviados (HTTP {status})")
                else:
                    print(f"  Lote {i // batch + 1}: resposta inesperada HTTP {status}")
        except urllib.error.HTTPError as e:
            corpo = e.read().decode('utf-8', errors='replace')
            print(f"  ERRO HTTP {e.code}: {corpo[:300]}")
        except Exception as e:
            print(f"  ERRO: {e}")

    return enviados


def main() -> None:
    parser = argparse.ArgumentParser(description='Envia trades JSON para o Supabase')
    parser.add_argument('--arquivo', default='data/rafi-trade-log.json',
                        help='Arquivo JSON com trades (padrão: data/rafi-trade-log.json)')
    parser.add_argument('--batch', type=int, default=50,
                        help='Trades por requisição (padrão: 50)')
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

    trades = json.loads(arquivo.read_text(encoding='utf-8'))
    if not isinstance(trades, list) or not trades:
        print("ERRO: JSON inválido ou vazio")
        sys.exit(1)

    print(f"Enviando {len(trades)} trades para o Supabase...")
    total = push_trades(url, key, trades, batch=args.batch)

    if total == len(trades):
        print(f"\nOK - {total} trades enviados ao Supabase")
    else:
        print(f"\nATENÇÃO - {total}/{len(trades)} trades enviados (verifique os erros acima)")
        sys.exit(1)


if __name__ == '__main__':
    main()
