"""
criar_tabelas_supabase.py — Cria as tabelas necessárias no Supabase.

Estratégia (tenta em ordem):
  1. Verifica via REST API quais tabelas já existem
  2. Tenta criar via Management API com SUPABASE_SERVICE_KEY
  3. Se falhar, exibe SQL pronto + link do Table Editor como alternativa

Configure o .env no VPS (adicione a linha abaixo):
  SUPABASE_SERVICE_KEY=eyJ...  <- cole o valor da chave service_role

Rode no VPS:
  cd C:\\RafiBot\\rafi-bot
  & "$env:LOCALAPPDATA\\Programs\\Python\\Python311\\python.exe" scripts/criar_tabelas_supabase.py
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
# SUPABASE_SERVICE_KEY: pode ser a chave service_role OU um Personal Access Token (PAT)
# PAT: https://supabase.com/dashboard/account/tokens  (começa com "sbp_")
# service_role: Dashboard -> Settings -> API -> service_role (começa com "eyJ")
SUPABASE_SERVICE_KEY = os.getenv('SUPABASE_SERVICE_KEY', '').strip()

if not SUPABASE_URL or not SUPABASE_KEY or 'xxxx' in SUPABASE_URL:
    print("[ERRO] SUPABASE_URL ou SUPABASE_KEY não configuradas no .env")
    sys.exit(1)

project_ref = SUPABASE_URL.replace('https://', '').split('.')[0]
print(f"[OK] Project ref: {project_ref}")

if not SUPABASE_SERVICE_KEY:
    print("[AVISO] SUPABASE_SERVICE_KEY não encontrada no .env")
    print("        Adicione ao .env: SUPABASE_SERVICE_KEY=<chave service_role>")
    print("        A tentativa de criação via API usará a SUPABASE_KEY (anon) — pode falhar.\n")
    SUPABASE_SERVICE_KEY = SUPABASE_KEY
else:
    tipo = "PAT" if SUPABASE_SERVICE_KEY.startswith('sbp_') else "service_role"
    print(f"[OK] SUPABASE_SERVICE_KEY configurada ({tipo})")


# ──────────────────────────────────────────────────────────────────────────────
# VERIFICAÇÃO — detecta o que já existe sem precisar de DDL
# ──────────────────────────────────────────────────────────────────────────────

def verificar_tabela(nome: str) -> bool:
    """Checa se a tabela existe via REST API (anon key — não precisa de DDL)."""
    url = f"{SUPABASE_URL}/rest/v1/{nome}?select=*&limit=0"
    req = urllib.request.Request(url, headers={
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
    })
    try:
        with urllib.request.urlopen(req, timeout=10):
            return True
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='ignore')
        # 404 ou "does not exist" = tabela não existe
        return 'does not exist' not in body and e.code not in (404, 400)
    except Exception:
        return False


def verificar_coluna(tabela: str, coluna: str) -> bool:
    """Checa se uma coluna existe selecionando-a com limit=0."""
    url = f"{SUPABASE_URL}/rest/v1/{tabela}?select={coluna}&limit=0"
    req = urllib.request.Request(url, headers={
        'apikey': SUPABASE_KEY,
        'Authorization': f'Bearer {SUPABASE_KEY}',
    })
    try:
        with urllib.request.urlopen(req, timeout=10):
            return True
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='ignore')
        return 'does not exist' not in body and 'column' not in body.lower()
    except Exception:
        return False


print("\n─────────────────────────────────────────")
print("ETAPA 1 — Verificando estado atual...")
print("─────────────────────────────────────────")

status_ok   = verificar_tabela('rafi_bot_status')
commands_ok = verificar_tabela('rafi_bot_commands')
pnl_ok      = verificar_coluna('rafi_trades', 'pnl')

print(f"  rafi_bot_status  : {'[OK] existe' if status_ok else '[FALTA]'}")
print(f"  rafi_bot_commands: {'[OK] existe' if commands_ok else '[FALTA]'}")
print(f"  rafi_trades.pnl  : {'[OK] existe' if pnl_ok else '[FALTA]'}")

if status_ok and commands_ok and pnl_ok:
    print("\n[OK] Tudo já existe! Nenhuma ação necessária.")
    print("Reinicie o bot: & \"$env:LOCALAPPDATA\\Programs\\Python\\Python311\\python.exe\" -m src.executor")
    sys.exit(0)


# ──────────────────────────────────────────────────────────────────────────────
# CRIAÇÃO — tenta via Management API (requer service_role ou PAT)
# ──────────────────────────────────────────────────────────────────────────────

def sql_via_api(query: str, descricao: str) -> bool:
    """Executa DDL via Supabase Management API com SUPABASE_SERVICE_KEY."""
    url = f"https://api.supabase.com/v1/projects/{project_ref}/database/query"
    payload = json.dumps({"query": query}).encode('utf-8')
    req = urllib.request.Request(
        url,
        data=payload,
        headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {SUPABASE_SERVICE_KEY}',
        },
        method='POST'
    )
    try:
        with urllib.request.urlopen(req, timeout=20):
            print(f"      [OK] {descricao}")
            return True
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='ignore')
        if 'already exists' in body or 'duplicate' in body.lower():
            print(f"      [OK] {descricao} (já existia)")
            return True
        print(f"      [FALHOU] HTTP {e.code} — {body[:300]}")
        return False
    except Exception as e:
        print(f"      [FALHOU] {e}")
        return False


print("\n─────────────────────────────────────────")
print("ETAPA 2 — Criando via Management API...")
print("─────────────────────────────────────────")

resultados = {}

if not status_ok:
    resultados['rafi_bot_status'] = sql_via_api("""
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
""", "tabela rafi_bot_status")

if not commands_ok:
    resultados['rafi_bot_commands'] = sql_via_api("""
create table if not exists rafi_bot_commands (
  id           bigint generated always as identity primary key,
  command      text not null,
  pending      boolean default true,
  created_at   timestamptz default now(),
  processed_at timestamptz
)
""", "tabela rafi_bot_commands")

if not pnl_ok:
    resultados['pnl'] = sql_via_api(
        "alter table rafi_trades add column if not exists pnl numeric(10,2)",
        "coluna pnl em rafi_trades"
    )

api_ok = all(resultados.values()) if resultados else True

if api_ok:
    print("\n[OK] Todas as tabelas criadas com sucesso via API!")
    print("Reinicie o bot: & \"$env:LOCALAPPDATA\\Programs\\Python\\Python311\\python.exe\" -m src.executor")
    sys.exit(0)


# ──────────────────────────────────────────────────────────────────────────────
# FALLBACK — Management API falhou; exibe opções e SQL para criar manualmente
# ──────────────────────────────────────────────────────────────────────────────

pendentes = []
if not status_ok and not resultados.get('rafi_bot_status'):
    pendentes.append('rafi_bot_status')
if not commands_ok and not resultados.get('rafi_bot_commands'):
    pendentes.append('rafi_bot_commands')
if not pnl_ok and not resultados.get('pnl'):
    pendentes.append('pnl em rafi_trades')

print(f"""
─────────────────────────────────────────
ETAPA 3 — Instruções para criação manual
─────────────────────────────────────────
Faltam: {', '.join(pendentes)}

A Management API exige um Personal Access Token (PAT), não a service_role key.

══ OPÇÃO A — Criar PAT (resolve de vez) ══
  1. Abra: https://supabase.com/dashboard/account/tokens
  2. Clique em "Generate new token"
  3. Nome: RafiBot DDL
  4. Copie o token (começa com "sbp_...")
  5. Adicione ao .env no VPS:
       SUPABASE_SERVICE_KEY=sbp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
  6. Execute este script novamente

══ OPÇÃO B — Table Editor (sem SQL, pelo navegador) ══
  Abra: https://supabase.com/dashboard/project/{project_ref}/editor
  Clique em "New table" e preencha os campos abaixo.

══ OPÇÃO C — SQL Editor (cole o SQL abaixo) ══
  Abra: https://supabase.com/dashboard/project/{project_ref}/sql/new
""")

# Exibe apenas o SQL das tabelas que faltam
if 'rafi_bot_status' in pendentes:
    print("""-- ① Tabela rafi_bot_status (heartbeat do bot)
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
);
""")

if 'rafi_bot_commands' in pendentes:
    print("""-- ② Tabela rafi_bot_commands (kill switch do dashboard)
create table if not exists rafi_bot_commands (
  id           bigint generated always as identity primary key,
  command      text not null,
  pending      boolean default true,
  created_at   timestamptz default now(),
  processed_at timestamptz
);
""")

if 'pnl em rafi_trades' in pendentes:
    print("-- ③ Coluna pnl na tabela existente rafi_trades")
    print("alter table rafi_trades add column if not exists pnl numeric(10,2);")
    print()

print("Após criar, execute este script novamente para confirmar.")
