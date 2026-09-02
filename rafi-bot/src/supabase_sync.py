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


def atualizar_resultado(ticket: int, result: str, ts: int,
                        pnl: Optional[float] = None) -> bool:
    """
    Atualiza o resultado (win/loss) de um trade já sincronizado.

    Chamado quando a posição é fechada pelo MT5.
    """
    cliente = _get_cliente()
    if cliente is None:
        return False

    trade_id = f"{ts}-mt5-{ticket}"
    patch: dict = {
        'result':     result,
        'updated_at': datetime.utcnow().isoformat(),
    }
    if pnl is not None:
        patch['pnl'] = round(pnl, 2)

    try:
        cliente.table('rafi_trades').update(patch).eq('id', trade_id).execute()
        logger.info(f"[Supabase] Ticket #{ticket} → {result.upper()}"
                    + (f" | P&L: ${pnl:+.2f}" if pnl is not None else ""))
        return True
    except Exception as e:
        logger.error(f"[Supabase] Erro ao atualizar resultado #{ticket}: {e}")
        return False


def publicar_heartbeat(
    status:         str,
    balance:        float,
    equity:         float,
    open_positions: int,
    pnl_hoje:       float = 0.0,
    par:            str   = 'EURUSD',
    server:         str   = '',
    account:        int   = 0,
    last_signal:    Optional[str] = None,
) -> bool:
    """
    Publica o status atual do bot na tabela rafi_bot_status (heartbeat).

    Chamado a cada ciclo para que o dashboard saiba que o bot está vivo.
    status: 'running' | 'waiting' | 'stopped' | 'error'
    """
    cliente = _get_cliente()
    if cliente is None:
        return False

    row = {
        'id':             'main',
        'status':         status,
        'balance':        round(balance, 2),
        'equity':         round(equity, 2),
        'open_positions': open_positions,
        'pnl_today':      round(pnl_hoje, 2),
        'par':            par,
        'server':         server,
        'account':        account,
        'last_signal':    last_signal,
        'updated_at':     datetime.utcnow().isoformat(),
    }

    try:
        cliente.table('rafi_bot_status').upsert(row, on_conflict='id').execute()
        return True
    except Exception as e:
        logger.error(f"[Supabase] Erro ao publicar heartbeat: {e}")
        return False


def publicar_candle(
    time_unix:  int,
    open_price: float,
    high:       float,
    low:        float,
    close:      float,
    volume:     float = 0.0,
    rafi:       Optional[float] = None,
) -> bool:
    """
    Publica o último candle M5 fechado na tabela rafi_candles.

    Chamado a cada ciclo para alimentar o gráfico em tempo real do dashboard.
    SQL para criar a tabela no Supabase (executar uma vez):
      create table rafi_candles (
        time bigint primary key,
        open float8, high float8, low float8, close float8,
        volume float8 default 0, rafi float8
      );
      alter table rafi_candles enable row level security;
      create policy "anon_r" on rafi_candles for select to anon using (true);
      create policy "anon_i" on rafi_candles for insert to anon with check (true);
      create policy "anon_u" on rafi_candles for update to anon using (true);
    """
    cliente = _get_cliente()
    if cliente is None:
        return False

    row = {
        'time':   time_unix,
        'open':   round(open_price, 5),
        'high':   round(high, 5),
        'low':    round(low, 5),
        'close':  round(close, 5),
        'volume': round(volume, 2),
        'rafi':   round(rafi, 4) if rafi is not None else None,
    }

    try:
        cliente.table('rafi_candles').upsert(row, on_conflict='time').execute()
        return True
    except Exception as e:
        logger.debug(f"[Supabase] rafi_candles não existe ou erro: {e}")
        return False


def publicar_candles_batch(candles_list: list) -> bool:
    """
    Publica uma lista de candles de uma vez (inicialização do bot).

    Cada item deve ser {'time', 'open', 'high', 'low', 'close', 'volume', 'rafi'}.
    """
    cliente = _get_cliente()
    if cliente is None or not candles_list:
        return False

    try:
        cliente.table('rafi_candles').upsert(candles_list, on_conflict='time').execute()
        logger.info(f"[Supabase] {len(candles_list)} candles publicados em batch")
        return True
    except Exception as e:
        logger.debug(f"[Supabase] Batch candles erro (tabela pode não existir): {e}")
        return False


def verificar_comando_avancado() -> Optional[dict]:
    """
    Verifica comandos avançados do dashboard: close_position, buy_manual, sell_manual.

    Retorna {'command': str} ou None se não houver comandos pendentes.
    """
    cliente = _get_cliente()
    if cliente is None:
        return None

    try:
        res = (
            cliente.table('rafi_bot_commands')
            .select('id,command')
            .eq('pending', True)
            .in_('command', ['close_position', 'buy_manual', 'sell_manual'])
            .order('created_at')
            .limit(1)
            .execute()
        )
        if not res.data:
            return None

        cmd = res.data[0]
        cmd_id = cmd.get('id')
        if cmd_id:
            cliente.table('rafi_bot_commands').update({
                'pending':      False,
                'processed_at': datetime.utcnow().isoformat(),
            }).eq('id', cmd_id).execute()

        logger.info(f"[Supabase] Comando avançado recebido: {cmd['command']}")
        return {'command': cmd['command']}
    except Exception as e:
        logger.error(f"[Supabase] Erro ao verificar comandos avançados: {e}")
        return None


def verificar_comando_parar() -> bool:
    """
    Verifica se há um comando de parada pendente na tabela rafi_bot_commands.

    Consome o primeiro comando 'stop' pendente e retorna True.
    Retorna False se não houver nenhum.
    """
    cliente = _get_cliente()
    if cliente is None:
        return False

    try:
        res = (
            cliente.table('rafi_bot_commands')
            .select('id,command')
            .eq('pending', True)
            .eq('command', 'stop')
            .order('created_at')
            .limit(1)
            .execute()
        )
        if not res.data:
            return False

        cmd_id = res.data[0].get('id')
        if cmd_id:
            cliente.table('rafi_bot_commands').update({
                'pending':      False,
                'processed_at': datetime.utcnow().isoformat(),
            }).eq('id', cmd_id).execute()

        logger.info("[Supabase] Comando STOP recebido do dashboard")
        return True
    except Exception as e:
        logger.error(f"[Supabase] Erro ao verificar comandos: {e}")
        return False
