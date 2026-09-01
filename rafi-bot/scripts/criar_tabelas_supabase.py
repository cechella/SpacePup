"""
criar_tabelas_supabase.py — Cria as tabelas necessárias no Supabase via API REST.

Rode no VPS:
  cd C:\RafiBot\rafi-bot
  python scripts/criar_tabelas_supabase.py
"""

import os
import sys
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

try:
    from supabase import create_client
except ImportError:
    print("[ERRO] supabase não instalado. Execute: pip install supabase")
    sys.exit(1)

url = os.getenv('SUPABASE_URL', '')
key = os.getenv('SUPABASE_KEY', '')

if not url or not key or 'xxxx' in url:
    print("[ERRO] SUPABASE_URL ou SUPABASE_KEY não configuradas no .env")
    sys.exit(1)

print(f"[OK] Conectando ao Supabase: {url}")
cliente = create_client(url, key)

# ── Teste de conexão ──────────────────────────────────────────────────────────
print("\n[1/3] Testando conexão com rafi_trades...")
try:
    res = cliente.table('rafi_trades').select('id').limit(1).execute()
    print(f"      OK — rafi_trades acessível ({len(res.data)} rows lidas)")
except Exception as e:
    print(f"      ERRO — {e}")
    print("      O banco ainda não está aceitando conexões. Aguarde mais alguns minutos.")
    sys.exit(1)

# ── Adicionar coluna pnl em rafi_trades ──────────────────────────────────────
print("\n[2/3] Verificando coluna pnl em rafi_trades...")
try:
    # Tenta ler a coluna pnl — se existir, não precisa criar
    res = cliente.table('rafi_trades').select('pnl').limit(1).execute()
    print("      OK — coluna pnl já existe")
except Exception as e:
    if 'pnl' in str(e).lower() or 'column' in str(e).lower():
        print("      Coluna pnl não existe — use o SQL Editor para adicionar:")
        print("      alter table rafi_trades add column if not exists pnl numeric(10,2);")
    else:
        print(f"      ERRO — {e}")

# ── Criar rafi_bot_status via upsert (cria a linha se a tabela existir) ──────
print("\n[3/3] Verificando rafi_bot_status...")
try:
    res = cliente.table('rafi_bot_status').select('id').limit(1).execute()
    print("      OK — tabela rafi_bot_status já existe")
    # Insere linha inicial se vazia
    if not res.data:
        cliente.table('rafi_bot_status').upsert({
            'id': 'main',
            'status': 'stopped',
            'balance': 0,
            'equity': 0,
            'open_positions': 0,
            'pnl_today': 0,
            'par': 'EURUSD',
        }, on_conflict='id').execute()
        print("      Linha inicial 'main' criada")
except Exception as e:
    print(f"      ERRO — tabela rafi_bot_status não existe ainda: {e}")
    print("      Crie via SQL Editor quando o banco estiver disponível.")

# ── Verificar rafi_bot_commands ───────────────────────────────────────────────
print("\n[4/4] Verificando rafi_bot_commands...")
try:
    res = cliente.table('rafi_bot_commands').select('id').limit(1).execute()
    print("      OK — tabela rafi_bot_commands já existe")
except Exception as e:
    print(f"      ERRO — tabela rafi_bot_commands não existe ainda: {e}")
    print("      Crie via SQL Editor quando o banco estiver disponível.")

print("\n─────────────────────────────────────────")
print("Resultado: verifique as mensagens acima.")
print("Tabelas que existem = bot funcionará normalmente.")
print("Tabelas com ERRO = ainda precisam ser criadas via SQL Editor.")
