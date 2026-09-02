"""
criar_tabelas_supabase.py — Cria as tabelas necessárias no Supabase via Management API.

Rode no VPS:
  cd C:\RafiBot\rafi-bot
  python scripts/criar_tabelas_supabase.py
"""

import os
import sys
import urllib.request
import urllib.error
import json
from pathlib import Path

# Carrega .env com suporte a BOM do PowerShell
for env_path in [Path('.env'), Path(__file__).parent.parent / '.env']:
    if env_path.exists():
        for linha in env_path.read_text(encoding='utf-8-sig').splitlines():
            linha = linha.strip()
            if '=' in linha and not linha.startswith('#'):
                chave, valor = linha.split('=', 1)
                os.environ[chave.strip()] = valor.strip()
        print(f"[OK] .env carregado de: {env_path.resolve()}")
        break

SUPABASE_URL = os.getenv('SUPABASE_URL', '').rstrip('/')
SUPABASE_KEY = os.getenv('SUPABASE_KEY', '')

if not SUPABASE_URL or not SUPABASE_KEY or 'xxxx' in SUPABASE_URL:
    print("[ERRO] SUPABASE_URL ou SUPABASE_KEY não configuradas")
    sys.exit(1)

# Extrai o project ref da URL (ex: fvvxwycdeirjenaytqif)
project_ref = SUPABASE_URL.replace('https://', '').split('.')[0]
print(f"[OK] Project ref: {project_ref}")


def sql_via_rest(query: str, descricao: str) -> bool:
    """Executa SQL via Supabase REST API (endpoint /rest/v1/rpc não serve para DDL).
    Usa a Management API do Supabase para executar SQL bruto."""
    # Endpoint de execução SQL via Management API
    url = f"https://api.supabase.com/v1/projects/{project_ref}/database/query"
    payload = json.dumps({"query": query}).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {SUPABASE_KEY}',
        },
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            print(f"      OK — {descricao}")
            return True
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='ignore')
        # 400 com "already exists" = já existe = OK
        if 'already exists' in body or 'duplicate' in body.lower():
            print(f"      OK — {descricao} (já existia)")
            return True
        print(f"      ERRO HTTP {e.code} — {body[:200]}")
        return False
    except Exception as e:
        print(f"      ERRO — {e}")
        return False


def testar_conexao() -> bool:
    """Testa conexão com a tabela rafi_trades via REST."""
    url = f"{SUPABASE_URL}/rest/v1/rafi_trades?select=id&limit=1"
    req = urllib.request.Request(url, headers={
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            print("      OK — rafi_trades acessível")
            return True
    except Exception as e:
        print(f"      ERRO — {e}")
        return False


print("\n[1/4] Testando conexão com rafi_trades...")
if not testar_conexao():
    print("      Banco inacessível. Aguarde e tente novamente.")
    sys.exit(1)

print("\n[2/4] Criando tabela rafi_bot_status...")
sql_via_rest("""
create table if not exists rafi_bot_status (
  id              text primary key default 'main',
  status          text not null default 'stopped',
  balance         numeric(12,2) default 0,
  equity          numeric(12,2) default 0,
  open_positions  int default 0,
  pnl_today       numeric(12,2) default 0,
  par             text default 'EURUSD',
  server          text default '',
  account         bigint default 0,
  last_signal     text,
  updated_at      timestamptz default now()
)
""", "rafi_bot_status")

print("\n[3/4] Criando tabela rafi_bot_commands...")
sql_via_rest("""
create table if not exists rafi_bot_commands (
  id           bigint generated always as identity primary key,
  command      text not null,
  pending      boolean default true,
  created_at   timestamptz default now(),
  processed_at timestamptz
)
""", "rafi_bot_commands")

print("\n[4/4] Adicionando coluna pnl em rafi_trades...")
sql_via_rest(
    "alter table rafi_trades add column if not exists pnl numeric(10,2)",
    "coluna pnl"
)

print("\n─────────────────────────────────────────")
print("Pronto! Reinicie o bot para começar a sincronizar.")
print("Comando: & \"$env:LOCALAPPDATA\\Programs\\Python\\Python311\\python.exe\" -m src.executor")
