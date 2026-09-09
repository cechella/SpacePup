"""
corrigir_pnl_historico.py — Corrige P&L errado nos trades já gravados no Supabase.

Problema: o bot calculava P&L como diff de saldo (race-condition),
gerando valores errados (ex: -$0.78 em vez de -$4.80).

Este script:
  1. Busca todos os trades com resultado WIN/LOSS no Supabase
  2. Para cada um, lê o P&L real via histórico de deals do MT5
  3. Atualiza pnl no Supabase com o valor correto

Uso (na pasta rafi-bot/, com MT5 aberto):
  py -u scripts/corrigir_pnl_historico.py
"""

import os
import sys
import logging
from pathlib import Path
from datetime import datetime, timezone

# Adiciona o src ao path para importar os módulos do bot
sys.path.insert(0, str(Path(__file__).parent.parent))

logging.basicConfig(level=logging.INFO, format='%(asctime)s | %(levelname)-8s | %(message)s')
logger = logging.getLogger(__name__)

# Carrega .env — tenta múltiplos nomes de variável usados no projeto
env_path = Path(__file__).parent.parent / '.env'
if env_path.exists():
    for line in env_path.read_text(encoding='utf-8').splitlines():
        line = line.strip()
        if line and not line.startswith('#') and '=' in line:
            k, v = line.split('=', 1)
            k = k.strip(); v = v.strip().strip('"').strip("'")
            os.environ.setdefault(k, v)
else:
    logger.warning(f".env não encontrado em {env_path}")

try:
    import MetaTrader5 as mt5
except ImportError:
    logger.error("MetaTrader5 não instalado ou não disponível neste ambiente.")
    sys.exit(1)

# Usa o cliente Supabase já configurado pelo módulo do bot
from src.supabase_sync import cliente as supa

if supa is None:
    logger.error("Cliente Supabase não inicializado — verifique SUPABASE_URL e SUPABASE_KEY no .env")
    sys.exit(1)


def pnl_real_do_mt5(position_ticket: int) -> dict | None:
    """Lê profit + commission + swap dos deals de uma posição fechada."""
    deals = mt5.history_deals_get(position=position_ticket)
    if not deals:
        return None
    bruto      = round(sum(d.profit     for d in deals), 2)
    commission = round(sum(d.commission for d in deals), 2)
    swap       = round(sum(d.swap       for d in deals), 2)
    return {'bruto': bruto, 'commission': commission, 'swap': swap,
            'liquido': round(bruto + commission + swap, 2)}


def main():
    # Conecta ao MT5
    if not mt5.initialize():
        logger.error(f"Falha ao inicializar MT5: {mt5.last_error()}")
        sys.exit(1)
    logger.info(f"MT5 conectado | Conta: {mt5.account_info().login}")

    # Busca trades fechados no Supabase (com ticket preenchido)
    res = supa.table('rafi_trades').select('id,ticket,pnl,result,entry,direction,created_at') \
              .in_('result', ['win', 'loss']) \
              .order('created_at', desc=False) \
              .execute()

    trades = res.data or []
    logger.info(f"{len(trades)} trades fechados encontrados no Supabase")

    corrigidos = 0
    sem_deals  = 0

    for t in trades:
        ticket = t.get('ticket')
        pnl_atual = t.get('pnl')

        if not ticket:
            continue

        pnl_info = pnl_real_do_mt5(int(ticket))

        if pnl_info is None:
            logger.warning(f"Ticket #{ticket} | Deals não encontrados no MT5 (trade muito antigo?)")
            sem_deals += 1
            continue

        pnl_correto = pnl_info['liquido']

        if pnl_atual is not None and abs(float(pnl_atual) - pnl_correto) < 0.01:
            logger.info(f"Ticket #{ticket} | P&L já correto: ${pnl_correto:+.2f} — pulando")
            continue

        logger.info(
            f"Ticket #{ticket} | {t['direction'].upper()} @ {t['entry']} | "
            f"P&L no banco: ${pnl_atual:+.2f} → correto: ${pnl_correto:+.2f} "
            f"(bruto={pnl_info['bruto']:+.2f} commission={pnl_info['commission']:+.2f})"
        )

        # Atualiza Supabase
        resultado_correto = 'win' if pnl_correto > 0 else 'loss'
        supa.table('rafi_trades').update({
            'pnl':        pnl_correto,
            'result':     resultado_correto,
            'updated_at': datetime.now(timezone.utc).isoformat(),
        }).eq('id', t['id']).execute()

        corrigidos += 1

    mt5.shutdown()
    logger.info(f"Concluído | {corrigidos} trade(s) corrigido(s) | {sem_deals} sem deals no MT5")


if __name__ == '__main__':
    main()
