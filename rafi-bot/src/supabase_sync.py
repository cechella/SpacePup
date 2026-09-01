"""
supabase_sync.py — Sincronização de trades com o Supabase (dashboard web)

Cada trade executado pelo bot é enviado ao Supabase para aparecer em tempo
real no admin (space-pup.vercel.app/admin).

Configuração: defina as variáveis de ambiente antes de rodar o bot:
  set SUPABASE_URL=https://xxxx.supabase.co
  set SUPABASE_KEY=eyJhbGci...

Ou adicione ao arquivo .env na raiz do rafi-bot/.
"""

import os
import logging
import time
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)

# Tentativa de importar supabase-py
try:
    from supabase import create_client, Client
    SUPABASE_DISPONIVEL = True
except ImportError:
    SUPABASE_DISPONIVEL = False
    logger.warning("supabase não instalado — execute: pip install supabase")


def _criar_cliente() -> Optional[object]:
    """Cria cliente Supabase a partir das variáveis de ambiente."""
    if not SUPABASE_DISPONIVEL:
        return None
    url = os.getenv('SUPABASE_URL', '')
    key = os.getenv('SUPABASE_KEY', '')
    if not url or not key or 'xxxx' in url:
        logger.warning("SUPABASE_URL ou SUPABASE_KEY não configuradas — sync desativado")
        return None
    try:
        return create_client(url, key)
    except Exception as e:
        logger.error(f"Erro ao criar cliente Supabase: {e}")
        return None


# Cliente singleton
_cliente: Optional[object] = None

def _get_cliente():
    global _cliente
    if _cliente is None:
        _cliente = _criar_cliente()
    return _cliente


def sincronizar_trade(
    ticket:      int,
    direction:   str,         # 'buy' ou 'sell'
    entry:       float,
    stop_loss:   float,
    take_profit: float,
    lot:         float,
    rafi:        Optional[float] = None,
    rafi_dir:    Optional[str]   = None,
    bb_width:    Optional[float] = None,
    result:      str             = 'pending',
    ts:          Optional[int]   = None,
) -> bool:
    """
    Upserta um trade no Supabase para aparecer no admin.

    Usa o ticket do MT5 como ID único — permite atualizar o resultado
    (win/loss) quando a posição for fechada.

    Retorna True se sincronizado com sucesso.
    """
    cliente = _get_cliente()
    if cliente is None:
        return False

    ts = ts or int(time.time())
    p  = lambda v: round(v, 5) if v is not None else None

    row = {
        'id':          f"{ts}-mt5-{ticket}",
        'direction':   'buy' if direction == 'compra' else 'sell',
        'entry':       p(entry),
        'stop_loss':   p(stop_loss),
        'take_profit': p(take_profit),
        'label':       f"MT5 {'▲ COMPRA' if direction == 'compra' else '▼ VENDA'} @ {entry:.5f} | {lot:.2f}L | #{ticket}",
        'time':        ts,
        'lot':         lot,
        'leverage':    1000,
        'result':      result,
        'rafi':        round(rafi, 3) if rafi is not None else None,
        'rafi_dir':    rafi_dir,
        'bb_width':    round(bb_width, 5) if bb_width is not None else None,
        'snapshot':    None,
        'updated_at':  datetime.utcnow().isoformat(),
    }

    try:
        cliente.table('rafi_trades').upsert(row, on_conflict='id').execute()
        logger.info(f"[Supabase] Ticket #{ticket} sincronizado ({result})")
        return True
    except Exception as e:
        logger.error(f"[Supabase] Erro ao sincronizar ticket #{ticket}: {e}")
        return False


def atualizar_resultado(ticket: int, result: str, ts: int) -> bool:
    """
    Atualiza o resultado (win/loss) de um trade já sincronizado.

    Chamado quando a posição é fechada pelo MT5.
    """
    cliente = _get_cliente()
    if cliente is None:
        return False

    trade_id = f"{ts}-mt5-{ticket}"
    try:
        cliente.table('rafi_trades').update({
            'result':     result,
            'updated_at': datetime.utcnow().isoformat(),
        }).eq('id', trade_id).execute()
        logger.info(f"[Supabase] Ticket #{ticket} → {result.upper()}")
        return True
    except Exception as e:
        logger.error(f"[Supabase] Erro ao atualizar resultado #{ticket}: {e}")
        return False
