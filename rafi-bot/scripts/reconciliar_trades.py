"""
scripts/reconciliar_trades.py — Reconcilia trades presos como 'pending' no Supabase
                                 com o histórico real do MetaTrader 5.

Problema que este script resolve:
  Quando o bot reinicia com posições abertas, ele perde o rastreamento interno
  delas. Quando o MT5 fecha essas posições (por SL ou TP), o bot não detecta o
  fechamento e os trades ficam presos com result='pending' no Supabase para sempre.

O que o script faz (somente leitura + updates pontuais no Supabase):
  1. Lê todos os trades com result='pending' do Supabase
  2. Extrai o ticket MT5 do campo 'id' (formato: "{ts}-mt5-{ticket}")
  3. Verifica no MT5 se a posição ainda está aberta
  4. Se NÃO está aberta → busca no histórico de deals do MT5:
       - Preço de fechamento real
       - Lucro/prejuízo reportado pelo broker
       - Resultado: 'win' se lucro > 0, 'loss' se lucro <= 0
  5. Atualiza o Supabase: result, pnl, close_price, updated_at

O script é SEGURO — não envia ordens, não altera parâmetros de risco.
Pode ser rodado quantas vezes quiser: é idempotente (re-processa somente pending).

Uso (rodar na mesma máquina com o MT5 aberto e logado):
  py scripts/reconciliar_trades.py
  py scripts/reconciliar_trades.py --dry-run   # mostra o que faria, sem alterar nada
  py scripts/reconciliar_trades.py --dias 60   # busca histórico dos últimos 60 dias (padrão: 90)
"""

import argparse
import os
import sys
import time
from datetime import datetime, timedelta
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

# ── Dependências ───────────────────────────────────────────────────────────────
try:
    import MetaTrader5 as mt5
    MT5_OK = True
except ImportError:
    MT5_OK = False
    print("ERRO: MetaTrader5 não instalado. Execute: pip install MetaTrader5")
    sys.exit(1)

try:
    from supabase import create_client
    SUPA_OK = True
except ImportError:
    SUPA_OK = False
    print("ERRO: supabase não instalado. Execute: pip install supabase")
    sys.exit(1)


def criar_supabase():
    url = os.getenv('SUPABASE_URL', '')
    key = os.getenv('SUPABASE_KEY', '')
    if not url or not key or 'xxxx' in url:
        print("ERRO: SUPABASE_URL ou SUPABASE_KEY não configuradas no .env")
        sys.exit(1)
    return create_client(url, key)


def extrair_ticket(trade_id: str) -> int | None:
    """
    Extrai o número do ticket MT5 do campo id do Supabase.
    Formato esperado: "{timestamp}-mt5-{ticket}"  ex: "1725000000-mt5-12345678"
    """
    partes = trade_id.split('-mt5-')
    if len(partes) == 2:
        try:
            return int(partes[1])
        except ValueError:
            pass
    return None


def buscar_deals_fechamento(ticket: int, desde: datetime) -> list:
    """
    Retorna todos os deals do histórico MT5 para a posição com esse ticket.
    O deal de fechamento tem entry == DEAL_ENTRY_OUT (1).
    """
    deals = mt5.history_deals_get(
        desde,
        datetime.utcnow() + timedelta(hours=1),
        position=ticket,
    )
    if not deals:
        return []
    return list(deals)


def reconciliar(dry_run: bool, dias: int) -> None:
    # ── Conecta ao MT5 ─────────────────────────────────────────────────────────
    if not mt5.initialize():
        print(f"ERRO: Não foi possível conectar ao MT5: {mt5.last_error()}")
        sys.exit(1)

    info = mt5.account_info()
    if info is None:
        print("ERRO: MT5 conectado mas sem conta logada.")
        mt5.shutdown()
        sys.exit(1)

    print(f"MT5 conectado: conta #{info.login} | servidor: {info.server}")

    # ── Conecta ao Supabase ────────────────────────────────────────────────────
    supa = criar_supabase()

    # ── Busca trades pendentes no Supabase ─────────────────────────────────────
    resp = (
        supa.table('rafi_trades')
        .select('id,direction,entry,stop_loss,take_profit,lot,time,result,pnl')
        .eq('result', 'pending')
        .order('time', desc=False)
        .execute()
    )

    pendentes = resp.data or []
    print(f"\n{len(pendentes)} trade(s) com result='pending' encontrados no Supabase.\n")

    if not pendentes:
        print("Nada a reconciliar.")
        mt5.shutdown()
        return

    # Tickets atualmente abertos no MT5 (não tocar neles)
    posicoes_abertas = mt5.positions_get()
    tickets_abertos = {p.ticket for p in posicoes_abertas} if posicoes_abertas else set()

    desde = datetime.utcnow() - timedelta(days=dias)

    atualizados = 0
    ainda_abertos = 0
    sem_historico = 0

    for trade in pendentes:
        trade_id = trade['id']
        ticket   = extrair_ticket(trade_id)

        if ticket is None:
            print(f"  [SKIP] ID sem ticket MT5: {trade_id}")
            continue

        # Posição ainda aberta no MT5 — não tocar
        if ticket in tickets_abertos:
            ainda_abertos += 1
            print(f"  [ABERTO]  #{ticket} — ainda aberta no MT5, mantém pending")
            continue

        # Busca no histórico de deals
        deals = buscar_deals_fechamento(ticket, desde)
        if not deals:
            sem_historico += 1
            print(f"  [SEM HIST] #{ticket} — não encontrado no histórico MT5 ({dias}d)")
            continue

        # O deal de fechamento tem DEAL_ENTRY_OUT = 1
        deal_fechamento = None
        for d in deals:
            if d.entry == mt5.DEAL_ENTRY_OUT:
                deal_fechamento = d
                break

        if deal_fechamento is None:
            # Fallback: usa o último deal da posição
            deal_fechamento = deals[-1]

        preco_saida = round(deal_fechamento.price, 5)
        lucro_broker = round(deal_fechamento.profit, 2)
        resultado = 'win' if lucro_broker > 0 else 'loss'

        print(
            f"  [{'DRY' if dry_run else 'FIX'}]  #{ticket} "
            f"{'▲' if trade['direction'] == 'buy' else '▼'} "
            f"entry={trade.get('entry') or 0:.5f} → saída={preco_saida:.5f} | "
            f"P&L=${lucro_broker:+.2f} | {resultado.upper()}"
        )

        if not dry_run:
            patch = {
                'result':      resultado,
                'pnl':         lucro_broker,
                'close_price': preco_saida,
                'updated_at':  datetime.utcnow().isoformat(),
            }
            # Corrige entry=0 se o MT5 tiver o preço real nos deals de abertura
            if (trade.get('entry') or 0) == 0:
                deal_abertura = next(
                    (d for d in deals if d.entry == mt5.DEAL_ENTRY_IN), None
                )
                if deal_abertura and deal_abertura.price > 0:
                    patch['entry'] = round(deal_abertura.price, 5)
                    print(f"           entry corrigido: 0 → {patch['entry']:.5f}")

            supa.table('rafi_trades').update(patch).eq('id', trade_id).execute()
            atualizados += 1
            time.sleep(0.1)  # respeita rate limit do Supabase

    # ── Relatório final ────────────────────────────────────────────────────────
    print(f"\n{'─' * 50}")
    print(f"Concluído {'(DRY RUN — nenhuma alteração feita)' if dry_run else ''}:")
    print(f"  Atualizados no Supabase : {atualizados}")
    print(f"  Ainda abertos no MT5    : {ainda_abertos}")
    print(f"  Sem histórico ({dias}d)  : {sem_historico}")
    print(f"  Total processados       : {len(pendentes)}")

    mt5.shutdown()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(
        description='Reconcilia trades pending no Supabase com o histórico do MT5'
    )
    parser.add_argument(
        '--dry-run', action='store_true',
        help='Mostra o que seria feito sem alterar nada no Supabase'
    )
    parser.add_argument(
        '--dias', type=int, default=90,
        help='Quantos dias de histórico MT5 consultar (padrão: 90)'
    )
    args = parser.parse_args()

    if args.dry_run:
        print("=== DRY RUN — nenhuma alteração será feita ===\n")

    reconciliar(dry_run=args.dry_run, dias=args.dias)
