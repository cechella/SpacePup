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
    status:            str,
    balance:           float,
    equity:            float,
    open_positions:    int,
    pnl_hoje:          float = 0.0,
    par:               str   = 'EURUSD',
    server:            str   = '',
    account:           int   = 0,
    last_signal:       Optional[str]   = None,
    forming_signal:    bool             = False,
    forming_direction: Optional[str]   = None,
    forming_rafi:      Optional[float] = None,
    forming_tf_count:  Optional[int]   = None,
    forming_bb_open:   bool             = False,
    forming_price:     Optional[float] = None,
    config_hash:       Optional[str]   = None,
) -> bool:
    """
    Publica o status atual do bot na tabela rafi_bot_status (heartbeat).

    Chamado a cada ciclo para que o dashboard saiba que o bot está vivo.
    status: 'running' | 'waiting' | 'stopped' | 'error'
    Os campos forming_* alimentam o card "Sinal em Formação" no admin.
    """
    cliente = _get_cliente()
    if cliente is None:
        return False

    row = {
        'id':                'main',
        'status':            status,
        'balance':           round(balance, 2),
        'equity':            round(equity, 2),
        'open_positions':    open_positions,
        'pnl_today':         round(pnl_hoje, 2),
        'par':               par,
        'server':            server,
        'account':           account,
        'last_signal':       last_signal,
        'forming_signal':    forming_signal,
        'forming_direction': forming_direction,
        'forming_rafi':      round(forming_rafi, 4) if forming_rafi is not None else None,
        'forming_tf_count':  forming_tf_count,
        'forming_bb_open':   forming_bb_open,
        'forming_price':     round(forming_price, 5) if forming_price is not None else None,
        'config_hash':       config_hash,
        'updated_at':        datetime.utcnow().isoformat(),
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


def publicar_log(
    message: str,
    level:   str = 'info',
    details: Optional[str] = None,
) -> bool:
    """
    Publica uma entrada de log na tabela rafi_bot_logs.

    level: 'info' | 'warn' | 'error' | 'signal'
    Alimenta o feed ao vivo do admin (ActivityFeed).

    SQL para criar a tabela no Supabase (executar uma vez):
      create table rafi_bot_logs (
        id uuid primary key default gen_random_uuid(),
        level text not null default 'info',
        message text not null,
        details text,
        created_at timestamptz not null default now()
      );
      alter table rafi_bot_logs enable row level security;
      create policy "anon_r" on rafi_bot_logs for select to anon using (true);
      create policy "anon_i" on rafi_bot_logs for insert to anon with check (true);
      -- Limpar logs antigos automaticamente (opcional):
      -- create index on rafi_bot_logs (created_at);
    """
    cliente = _get_cliente()
    if cliente is None:
        return False

    row = {
        'level':      level,
        'message':    message,
        'details':    details,
        'created_at': datetime.utcnow().isoformat(),
    }

    try:
        cliente.table('rafi_bot_logs').insert(row).execute()
        return True
    except Exception as e:
        # Falha silenciosa — log não bloqueia o bot
        logger.debug(f"[Supabase] rafi_bot_logs erro (tabela pode não existir): {e}")
        return False


def carregar_broker_ativo(broker_id: Optional[str] = None) -> Optional[dict]:
    """
    Retorna os dados da corretora ativa no Supabase.

    broker_id : se fornecido via --broker, filtra por esse ID específico.
                Se None, retorna o primeiro enabled=true encontrado.

    Tabela rafi_brokers — SQL para criar (executar uma vez no Supabase):
      create table rafi_brokers (
        id text primary key,          -- 'xm', 'pepperstone'
        nome text not null,
        servidor text not null,
        login integer not null,
        simbolo text not null,        -- 'EURUSD#' (XM) ou 'EURUSD' (Pepperstone)
        enabled boolean default false,
        saldo float8 default 0,
        posicoes integer default 0,
        pnl_hoje float8 default 0,
        status_text text default 'DESLIGADA',
        updated_at timestamptz default now()
      );
      alter table rafi_brokers enable row level security;
      create policy "anon_r" on rafi_brokers for select to anon using (true);
      create policy "anon_u" on rafi_brokers for update to anon using (true);
      -- Inserir corretoras iniciais:
      insert into rafi_brokers (id, nome, servidor, login, simbolo, enabled) values
        ('xm',          'XM Global',   'XMGlobal-MT5 4',           86082468, 'EURUSD#', true),
        ('pepperstone', 'Pepperstone', 'PepperstoneBS-MT5-Live01', 51552485, 'EURUSD',  false);
    """
    cliente = _get_cliente()
    if not cliente:
        return None
    try:
        q = cliente.table('rafi_brokers').select('*').eq('enabled', True)
        if broker_id:
            q = q.eq('id', broker_id)
        resp = q.limit(1).execute()
        if resp.data:
            logger.info(f"[Supabase] Broker ativo: {resp.data[0]['id']}")
            return resp.data[0]
        return None
    except Exception as e:
        logger.warning(f"rafi_brokers não disponível ({e}) — usando config.yaml")
        return None


def publicar_status_broker(
    broker_id:   str,
    saldo:       float,
    posicoes:    int,
    pnl_hoje:    float,
    status_text: str,
) -> bool:
    """
    Atualiza o card da corretora ativa no Supabase (saldo, posições, P&L).

    Chamado a cada heartbeat para que o dashboard mostre dados ao vivo
    no painel /admin/brokers.
    """
    cliente = _get_cliente()
    if cliente is None:
        return False
    try:
        cliente.table('rafi_brokers').update({
            'saldo':       round(saldo, 2),
            'posicoes':    posicoes,
            'pnl_hoje':    round(pnl_hoje, 2),
            'status_text': status_text,
            'updated_at':  datetime.utcnow().isoformat(),
        }).eq('id', broker_id).execute()
        return True
    except Exception as e:
        logger.debug(f"[Supabase] publicar_status_broker erro: {e}")
        return False


def gravar_rafi_trade(
    resultado:         int,              # 1=win 0=loss
    lucro_r:           float,            # em múltiplos de R (1.3 win / -1.0 loss)
    lucro_usd:         Optional[float]  = None,
    lotes:             Optional[float]  = None,
    direcao:           Optional[int]    = None,   # +1 compra / -1 venda
    forca_rompimento:  Optional[float]  = None,
    rr_ratio:          Optional[float]  = None,
    preco_entrada:     Optional[float]  = None,
    preco_saida:       Optional[float]  = None,
    preco_stop:        Optional[float]  = None,
    preco_target:      Optional[float]  = None,
    probabilidade_ml:  Optional[float]  = None,
    ml_aprovado:       Optional[bool]   = None,
    perfil:            str              = 'live',
) -> bool:
    """
    Grava o resultado de um trade fechado na tabela rafi_historico.

    Essa tabela alimenta o modelo XGBoost (retreino automático) e o monitor
    de performance (WR/PF rolling). É diferente da tabela rafi_trades, que
    exibe trades em andamento no dashboard admin.
    """
    cliente = _get_cliente()
    if cliente is None:
        return False

    p5 = lambda v: round(v, 5) if v is not None else None
    p4 = lambda v: round(v, 4) if v is not None else None
    p2 = lambda v: round(v, 2) if v is not None else None

    row = {
        'aberto_em':        datetime.utcnow().isoformat(),
        'perfil':           perfil,
        'resultado':        resultado,
        'lucro_r':          p4(lucro_r),
        'lucro_usd':        p2(lucro_usd),
        'lotes':            p2(lotes),
        'direcao':          direcao,
        'forca_rompimento': p5(forca_rompimento),
        'rr_ratio':         p4(rr_ratio),
        'preco_entrada':    p5(preco_entrada),
        'preco_saida':      p5(preco_saida),
        'preco_stop':       p5(preco_stop),
        'preco_target':     p5(preco_target),
        'probabilidade_ml': p4(probabilidade_ml),
        'ml_aprovado':      ml_aprovado,
        'ml_threshold':     0.65,
    }

    try:
        cliente.table('rafi_historico').insert(row).execute()
        logger.info(
            f"[Supabase] Trade gravado → {'WIN' if resultado else 'LOSS'} "
            f"| R={lucro_r:+.2f} | ML={probabilidade_ml:.1%}" if probabilidade_ml else
            f"[Supabase] Trade gravado → {'WIN' if resultado else 'LOSS'} | R={lucro_r:+.2f}"
        )
        return True
    except Exception as e:
        logger.error(f"[Supabase] Erro ao gravar trade ML: {e}")
        return False


def carregar_config_supabase(profile: str = 'live') -> Optional[dict]:
    """
    Carrega configurações do perfil indicado na tabela rafi_bot_config.

    Retorna dict com os parâmetros ou None se a tabela/perfil não existir.
    O bot usa esses valores para sobrescrever o config.yaml — qualquer ajuste
    feito no dashboard (/admin/config) é aplicado imediatamente sem tocar no código.

    Parâmetros:
      profile : 'live' (bot ao vivo) ou 'simulator' (backtest)
    """
    cliente = _get_cliente()
    if not cliente:
        return None
    try:
        resp = cliente.table('rafi_bot_config').select('*').eq('profile', profile).limit(1).execute()
        if resp.data:
            logger.info(f"[Supabase] Config '{profile}' carregada do dashboard")
            return resp.data[0]
        return None
    except Exception as e:
        logger.warning(f"rafi_bot_config não disponível ({e}) — usando config.yaml")
        return None
