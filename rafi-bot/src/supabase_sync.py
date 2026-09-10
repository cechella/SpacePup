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


def publicar_config_hash_startup(config_hash: str) -> bool:
    """
    Força a gravação do config_hash em rafi_bot_status no startup do bot.

    Usa UPDATE separado do heartbeat para garantir que o campo seja atualizado
    mesmo em versões do PostgREST que ignoram colunas desconhecidas no upsert.
    Se a linha ainda não existir, faz INSERT mínimo com id='main'.
    """
    cliente = _get_cliente()
    if cliente is None:
        return False
    ts = datetime.utcnow().isoformat()
    try:
        # Tenta UPDATE primeiro (linha já existe)
        res = cliente.table('rafi_bot_status').update(
            {'config_hash': config_hash, 'updated_at': ts}
        ).eq('id', 'main').execute()
        if hasattr(res, 'error') and res.error:
            raise RuntimeError(res.error)
        # UPDATE retorna lista vazia se nenhuma linha foi afetada — nesse caso faz INSERT
        if hasattr(res, 'data') and res.data is not None and len(res.data) == 0:
            res2 = cliente.table('rafi_bot_status').insert(
                {'id': 'main', 'status': 'waiting', 'balance': 0, 'equity': 0,
                 'open_positions': 0, 'config_hash': config_hash, 'updated_at': ts}
            ).execute()
            if hasattr(res2, 'error') and res2.error:
                raise RuntimeError(res2.error)
        logger.info(f"[Supabase] config_hash publicado no startup: {config_hash}")
        return True
    except Exception as e:
        logger.error(f"[Supabase] Falha ao publicar config_hash no startup: {e}")
        return False


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
    broker_id:         str              = 'main',   # ID da linha no Supabase
    # ── campos ML (Fase 2) ────────────────────────────────────────────────
    ml_modelo_carregado: bool            = False,
    ml_modo:             str             = 'OBSERVAÇÃO',
    ml_wr_rolling:       Optional[float] = None,
    ml_pf_rolling:       Optional[float] = None,
    ml_sinais_hoje:      int             = 0,
    ml_aprovados_hoje:   int             = 0,
    ml_treinado_em:      Optional[str]   = None,
    ml_threshold:        float           = 0.65,
) -> bool:
    """
    Publica o status atual do bot na tabela rafi_bot_status (heartbeat).

    Chamado a cada ciclo para que o dashboard saiba que o bot está vivo.
    status: 'running' | 'waiting' | 'stopped' | 'error'
    broker_id: ID único do broker ('pepperstone', 'exness', 'tickmill') —
               cada processo escreve na sua própria linha, evitando conflitos.
    Os campos forming_* alimentam o card "Sinal em Formação" no admin.
    Os campos ml_* alimentam o painel de ML / Fase 2 no monitor.
    """
    cliente = _get_cliente()
    if cliente is None:
        return False

    row = {
        'id':                broker_id,
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
        # campos ML
        'ml_modelo_carregado': ml_modelo_carregado,
        'ml_modo':             ml_modo,
        'ml_wr_rolling':       round(ml_wr_rolling, 4) if ml_wr_rolling is not None else None,
        'ml_pf_rolling':       round(ml_pf_rolling, 4) if ml_pf_rolling is not None else None,
        'ml_sinais_hoje':      ml_sinais_hoje,
        'ml_aprovados_hoje':   ml_aprovados_hoje,
        'ml_treinado_em':      ml_treinado_em,
        'ml_threshold':        round(ml_threshold, 4),
        'updated_at':          datetime.utcnow().isoformat(),
    }

    try:
        res = cliente.table('rafi_bot_status').upsert(row, on_conflict='id').execute()
        # supabase-py ≥2.x levanta exceção em erros HTTP; versões mais antigas retornam .error
        if hasattr(res, 'error') and res.error:
            logger.error(f"[Supabase] Erro no upsert rafi_bot_status: {res.error}")
            return False
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
    Verifica comandos avançados do dashboard: close_position, close_all,
    buy_manual, sell_manual, start, restart.

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
            .in_('command', ['close_position', 'close_all', 'buy_manual', 'sell_manual',
                             'start', 'restart'])
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
        q = cliente.table('rafi_brokers').select(
            'id,nome,servidor,login,simbolo,enabled,saldo,'
            'posicoes,pnl_hoje,status_text,updated_at,'
            'mt5_login,mt5_senha,mt5_servidor,mt5_simbolo,mt5_path'
        ).eq('enabled', True)
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


def carregar_credenciais_broker(broker_id: str) -> Optional[dict]:
    """
    Carrega credenciais MT5 salvas pelo dashboard admin (mt5_login, mt5_senha,
    mt5_servidor, mt5_simbolo, mt5_path) da tabela rafi_brokers.

    Retorna dict apenas com campos preenchidos, ou None se indisponível.
    O executor usa esses valores com prioridade sobre o config.yaml.
    """
    cliente = _get_cliente()
    if not cliente:
        return None
    try:
        resp = (
            cliente.table('rafi_brokers')
            .select('mt5_login,mt5_senha,mt5_servidor,mt5_simbolo,mt5_path')
            .eq('id', broker_id)
            .single()
            .execute()
        )
        if resp.data:
            creds = {k: v for k, v in resp.data.items() if v}
            if creds:
                logger.info(f"[Supabase] Credenciais MT5 de '{broker_id}' carregadas do dashboard")
            return creds or None
        return None
    except Exception as e:
        logger.debug(f"[Supabase] Credenciais de '{broker_id}' não disponíveis: {e}")
        return None


def publicar_status_broker(
    broker_id:    str,
    saldo:        float,
    posicoes:     int,
    pnl_hoje:     float,
    status_text:  str,
    servidor_real: Optional[str] = None,  # servidor MT5 real conectado
) -> bool:
    """
    Atualiza o card da corretora ativa no Supabase (saldo, posições, P&L).

    Chamado a cada heartbeat para que o dashboard mostre dados ao vivo
    no painel /admin/brokers.

    servidor_real: nome do servidor MT5 ao qual o bot está de fato conectado.
    Se não bater com o servidor esperado para este broker_id, grava
    ERRO_TERMINAL (evita que dados de outro broker contaminem este card).
    """
    cliente = _get_cliente()
    if cliente is None:
        return False
    try:
        # Valida terminal MT5 conectado antes de gravar saldo/posições
        if servidor_real:
            res = cliente.table('rafi_brokers').select('servidor').eq('id', broker_id).execute()
            if res.data:
                servidor_esperado = res.data[0].get('servidor', '')
                if servidor_esperado and servidor_real not in servidor_esperado:
                    logger.warning(
                        f"[Supabase] {broker_id}: terminal errado! "
                        f"conectado='{servidor_real}' esperado='{servidor_esperado}' "
                        f"— gravando ERRO_TERMINAL, saldo zerado."
                    )
                    cliente.table('rafi_brokers').update({
                        'saldo':       0.0,
                        'posicoes':    0,
                        'pnl_hoje':    0.0,
                        'status_text': 'ERRO_TERMINAL',
                        'updated_at':  datetime.utcnow().isoformat(),
                    }).eq('id', broker_id).execute()
                    return False

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


def verificar_backtest_pendente() -> Optional[dict]:
    """
    Retorna o run de backtest mais antigo com status='pending', ou None.

    Chamado pelo executor a cada ciclo para detectar solicitações vindas do admin.

    Tabela rafi_backtest_runs — SQL para criar (executar uma vez no Supabase):
      create table rafi_backtest_runs (
        id uuid primary key default gen_random_uuid(),
        created_at timestamptz default now(),
        periodo text,
        inicio date,
        fim date,
        capital real default 20.0,
        profile text default 'simulator',
        status text default 'pending',
        config_hash text,
        progress_pct integer default 0,
        resultado jsonb,
        trades_json jsonb,
        error_msg text,
        updated_at timestamptz default now()
      );
      alter table rafi_backtest_runs enable row level security;
      create policy "anon_r"  on rafi_backtest_runs for select to anon using (true);
      create policy "anon_i"  on rafi_backtest_runs for insert to anon with check (true);
      create policy "anon_u"  on rafi_backtest_runs for update to anon using (true);
    """
    cliente = _get_cliente()
    if cliente is None:
        return None
    try:
        res = (
            cliente.table('rafi_backtest_runs')
            .select('id,periodo,inicio,fim,capital,profile')
            .eq('status', 'pending')
            .order('created_at')
            .limit(1)
            .execute()
        )
        return res.data[0] if res.data else None
    except Exception as e:
        logger.debug(f"[Supabase] rafi_backtest_runs não disponível: {e}")
        return None


def atualizar_backtest_run(
    run_id:      str,
    status:      str,
    config_hash: Optional[str]  = None,
    resultado:   Optional[dict] = None,
    trades_json: Optional[list] = None,
    error_msg:   Optional[str]  = None,
    progress:    int            = 0,
) -> bool:
    """Atualiza status e resultado de um run de backtest na tabela rafi_backtest_runs."""
    cliente = _get_cliente()
    if cliente is None:
        return False
    patch: dict = {
        'status':       status,
        'progress_pct': progress,
        'updated_at':   datetime.utcnow().isoformat(),
    }
    if config_hash is not None:
        patch['config_hash'] = config_hash
    if resultado is not None:
        patch['resultado'] = resultado
    if trades_json is not None:
        patch['trades_json'] = trades_json
    if error_msg is not None:
        patch['error_msg'] = error_msg
    try:
        cliente.table('rafi_backtest_runs').update(patch).eq('id', run_id).execute()
        return True
    except Exception as e:
        logger.error(f"[Supabase] Erro ao atualizar backtest run {run_id}: {e}")
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


def carregar_faixas_lote() -> list[tuple[float, float, float]]:
    """
    Carrega a tabela de faixas de lote do Supabase (rafi_lote_faixas).

    Retorna lista de tuplas (capital_min, capital_max, lote) ordenada por capital_min.
    Se o Supabase estiver indisponível ou a tabela não existir, retorna o fallback
    hardcoded — garantia de que o bot nunca para por falta de conexão.

    Chamado por risk_manager.lote_por_faixa() e backtest/engine.py a cada ciclo
    de decisão (com cache interno de 5 minutos para não sobrecarregar o banco).
    """
    cliente = _get_cliente()
    if not cliente:
        return []  # fallback será aplicado pelo chamador
    try:
        resp = (
            cliente.table('rafi_lote_faixas')
            .select('capital_min,capital_max,lote')
            .eq('ativo', True)
            .order('ordem')
            .execute()
        )
        if not resp.data:
            return []
        faixas: list[tuple[float, float, float]] = []
        for row in resp.data:
            cap_min = float(row['capital_min'])
            cap_max = float(row['capital_max']) if row['capital_max'] is not None else float('inf')
            lote    = float(row['lote'])
            faixas.append((cap_min, cap_max, lote))
        logger.info(f"[Supabase] {len(faixas)} faixas de lote carregadas do dashboard")
        return faixas
    except Exception as e:
        logger.warning(f"[Supabase] rafi_lote_faixas indisponível ({e}) — usando fallback hardcoded")
        return []


def salvar_config_supabase(
    params: dict,
    perfil: str  = 'live',
    fonte: str   = 'otimizador_adaptativo',
) -> bool:
    """
    Salva novos parâmetros de estratégia no Supabase (rafi_bot_config).

    Chamado pelo otimizador_adaptativo quando encontra parâmetros melhores.
    O bot lê automaticamente na próxima iteração via carregar_config_supabase().

    IMPORTANTE: nunca sobrescreve parâmetros de risco (risco_por_trade, etc.).
    Só atualiza os campos presentes em `params`.
    """
    cliente = _get_cliente()
    if not cliente:
        logger.warning("[Supabase] salvar_config_supabase: cliente indisponível")
        return False

    # Campos de risco que a IA NUNCA pode alterar
    CAMPOS_PROTEGIDOS = {
        'risco_por_trade', 'max_trades_simultaneos', 'risco_maximo_diario',
        'capital_inicial', 'estrategia_modo', 'par',
    }
    patch = {k: v for k, v in params.items() if k not in CAMPOS_PROTEGIDOS}
    patch['_otimizado_em']  = datetime.utcnow().isoformat()
    patch['_otimizado_por'] = fonte

    try:
        # Verifica se o perfil já existe
        resp = cliente.table('rafi_bot_config').select('profile').eq('profile', perfil).limit(1).execute()

        if resp.data:
            # Atualiza apenas os campos otimizados — preserva tudo o mais
            cliente.table('rafi_bot_config').update(patch).eq('profile', perfil).execute()
        else:
            # Cria registro do perfil com os parâmetros
            patch['profile'] = perfil
            cliente.table('rafi_bot_config').insert(patch).execute()

        logger.info(
            f"[Supabase] Config '{perfil}' atualizada pela IA ({fonte}) — "
            f"{len(patch)} campos alterados"
        )
        return True

    except Exception as e:
        logger.error(f"[Supabase] Erro ao salvar config: {e}")
        return False


# ══════════════════════════════════════════════════════════════════════════════
# BROKER HEALTH ENGINE — funções Supabase (sem fallback hardcoded)
# ══════════════════════════════════════════════════════════════════════════════

def carregar_config_broker_health() -> dict:
    """
    Carrega TODOS os parâmetros do Broker Health Engine do Supabase
    (tabela broker_health_config).

    Retorna dicionário {chave: valor_float}.

    CRÍTICO: Se o Supabase estiver indisponível ou a tabela estiver vazia,
    lança RuntimeError — o bot DEVE parar, sem fallback hardcoded.
    """
    cliente = _get_cliente()
    if not cliente:
        raise RuntimeError(
            "Supabase indisponível — impossível carregar broker_health_config. "
            "Bot não pode operar sem os parâmetros de health. Verifique as "
            "variáveis SUPABASE_URL e SUPABASE_KEY."
        )

    try:
        resp = cliente.table('broker_health_config').select('chave,valor').execute()
    except Exception as e:
        raise RuntimeError(
            f"Falha ao consultar broker_health_config no Supabase: {e}. "
            f"Bot parando por segurança."
        )

    if not resp.data:
        raise RuntimeError(
            "broker_health_config está vazia no Supabase. "
            "Execute o script migrate_broker_health.sql antes de iniciar o bot."
        )

    config = {row['chave']: float(row['valor']) for row in resp.data}
    logger.debug(f"[Supabase] broker_health_config carregada: {len(config)} parâmetros")
    return config


def publicar_metricas_broker(metricas) -> bool:
    """
    Publica um snapshot de MetricasBroker na tabela broker_health_metrics.
    Retorna True se publicado com sucesso, False em caso de erro.
    """
    cliente = _get_cliente()
    if not cliente:
        logger.warning("[Supabase] Métricas de broker não publicadas — cliente indisponível")
        return False

    payload = {
        'broker_id'              : metricas.broker_id,
        'coletado_em'            : metricas.coletado_em.isoformat(),
        'connection_status'      : metricas.connection_status,
        'heartbeat_latency_ms'   : metricas.heartbeat_latency_ms,
        'api_response_time_ms'   : metricas.api_response_time_ms,
        'disconnect_count'       : metricas.disconnect_count,
        'reconnect_frequency'    : metricas.reconnect_frequency,
        'uptime_pct'             : metricas.uptime_pct,
        'order_execution_time_ms': metricas.order_execution_time_ms,
        'fill_rate_pct'          : metricas.fill_rate_pct,
        'partial_fill_rate_pct'  : metricas.partial_fill_rate_pct,
        'reject_rate_pct'        : metricas.reject_rate_pct,
        'requote_rate_pct'       : metricas.requote_rate_pct,
        'timeout_rate_pct'       : metricas.timeout_rate_pct,
        'api_error_rate_pct'     : metricas.api_error_rate_pct,
        'spread_pips'            : metricas.spread_pips,
        'effective_spread_pips'  : metricas.effective_spread_pips,
        'slippage_pips'          : metricas.slippage_pips,
        'commission_per_lot'     : metricas.commission_per_lot,
        'pnl_liquido_medio_usd'  : metricas.pnl_liquido_medio_usd,
        'pnl_por_pip_usd'        : metricas.pnl_por_pip_usd,
        'custo_total_pips'       : metricas.custo_total_pips,
        'free_margin_usd'        : metricas.free_margin_usd,
        'margin_level_pct'       : metricas.margin_level_pct,
        'price_feed_delay_ms'    : metricas.price_feed_delay_ms,
        'price_feed_stability'   : metricas.price_feed_stability,
        'metricas_indisponiveis' : metricas.metricas_indisponiveis,
    }

    try:
        cliente.table('broker_health_metrics').insert(payload).execute()
        return True
    except Exception as e:
        logger.error(f"[Supabase] Erro ao publicar métricas de {metricas.broker_id}: {e}")
        return False


def publicar_health_score(score) -> bool:
    """
    Publica um HealthScore calculado na tabela broker_health_scores.
    Retorna True se publicado com sucesso.
    """
    cliente = _get_cliente()
    if not cliente:
        logger.warning("[Supabase] Health score não publicado — cliente indisponível")
        return False

    payload = {
        'broker_id'           : score.broker_id,
        'calculado_em'        : score.calculado_em.isoformat(),
        'health_score'        : score.health_score,
        'dim_pnl'             : score.dim_pnl,
        'dim_spread'          : score.dim_spread,
        'dim_execucao'        : score.dim_execucao,
        'dim_conectividade'   : score.dim_conectividade,
        'dim_margem'          : score.dim_margem,
        'dim_estabilidade'    : score.dim_estabilidade,
        'amostra_insuficiente': score.amostra_insuficiente,
        'anomalia_ativa'      : score.anomalia_ativa,
    }

    try:
        cliente.table('broker_health_scores').insert(payload).execute()
        return True
    except Exception as e:
        logger.error(f"[Supabase] Erro ao publicar health score de {score.broker_id}: {e}")
        return False


def publicar_estado_broker(broker_id: str, estado: str, circuit_breaker: str,
                            health_score: float, consecutivos_ok: int,
                            consecutivos_ruim: int, quarentena_ate,
                            override_manual: Optional[str],
                            motivo_estado: str) -> bool:
    """
    Atualiza (upsert) o estado atual do broker em broker_health_state e
    sincroniza health_score + health_estado em rafi_brokers.

    Usa upsert para garantir que a linha exista (criada pela migração).
    Retorna True se bem-sucedido.
    """
    cliente = _get_cliente()
    if not cliente:
        logger.warning(f"[Supabase] Estado de {broker_id} não publicado — cliente indisponível")
        return False

    agora = datetime.utcnow().isoformat()

    state_payload = {
        'broker_id'        : broker_id,
        'estado'           : estado,
        'circuit_breaker'  : circuit_breaker,
        'health_score'     : health_score,
        'consecutivos_ok'  : consecutivos_ok,
        'consecutivos_ruim': consecutivos_ruim,
        'quarentena_ate'   : quarentena_ate.isoformat() if quarentena_ate else None,
        'override_manual'  : override_manual,
        'motivo_estado'    : motivo_estado,
        'atualizado_em'    : agora,
    }

    try:
        (cliente.table('broker_health_state')
                .upsert(state_payload, on_conflict='broker_id')
                .execute())

        # Sincroniza snapshot no cartão do broker (rafi_brokers)
        (cliente.table('rafi_brokers')
                .update({'health_score': health_score, 'health_estado': estado})
                .eq('id', broker_id)
                .execute())

        return True
    except Exception as e:
        logger.error(f"[Supabase] Erro ao publicar estado de {broker_id}: {e}")
        return False


def carregar_estado_broker(broker_id: str) -> Optional[dict]:
    """
    Carrega o estado persistido de um broker do Supabase (broker_health_state).
    Retorna dict com 'estado', 'circuit_breaker', etc., ou None se não encontrado.
    """
    cliente = _get_cliente()
    if not cliente:
        return None

    try:
        resp = (cliente.table('broker_health_state')
                       .select('*')
                       .eq('broker_id', broker_id)
                       .single()
                       .execute())
        return resp.data
    except Exception as e:
        logger.debug(f"[Supabase] Estado de {broker_id} não encontrado: {e}")
        return None


def carregar_ultima_metrica_broker(broker_id: str) -> Optional[object]:
    """
    Retorna a MetricasBroker mais recente do broker, reconstruída a partir do
    registro mais novo em broker_health_metrics.
    Retorna None se não houver métricas.
    """
    from .broker_telemetry import MetricasBroker
    from datetime import timezone

    cliente = _get_cliente()
    if not cliente:
        return None

    try:
        resp = (cliente.table('broker_health_metrics')
                       .select('*')
                       .eq('broker_id', broker_id)
                       .order('coletado_em', desc=True)
                       .limit(1)
                       .single()
                       .execute())
        if not resp.data:
            return None

        r = resp.data
        m = MetricasBroker(broker_id=broker_id)

        # Converte timestamp
        from datetime import datetime
        coletado = r.get('coletado_em')
        if coletado:
            try:
                m.coletado_em = datetime.fromisoformat(coletado.replace('Z', '+00:00'))
            except Exception:
                m.coletado_em = datetime.now(timezone.utc)

        # Mapeia campos do banco para o dataclass
        for campo in [
            'connection_status', 'heartbeat_latency_ms', 'api_response_time_ms',
            'disconnect_count', 'reconnect_frequency', 'uptime_pct',
            'order_execution_time_ms', 'fill_rate_pct', 'partial_fill_rate_pct',
            'reject_rate_pct', 'requote_rate_pct', 'timeout_rate_pct', 'api_error_rate_pct',
            'spread_pips', 'effective_spread_pips', 'slippage_pips', 'commission_per_lot',
            'pnl_liquido_medio_usd', 'pnl_por_pip_usd', 'custo_total_pips',
            'free_margin_usd', 'margin_level_pct', 'price_feed_delay_ms', 'price_feed_stability',
        ]:
            valor = r.get(campo)
            if valor is not None:
                setattr(m, campo, valor)

        m.metricas_indisponiveis = r.get('metricas_indisponiveis') or []
        return m

    except Exception as e:
        logger.debug(f"[Supabase] Sem métricas recentes para {broker_id}: {e}")
        return None


def carregar_todos_brokers_enabled() -> list:
    """
    Retorna lista de dicts com todos os brokers habilitados no Supabase
    (rafi_brokers onde enabled = true).

    Usada pelo broker_coordinator para montar o ranking cross-broker.
    Retorna lista vazia em caso de erro (não lança exceção — apenas avisa).
    """
    cliente = _get_cliente()
    if not cliente:
        logger.warning("[Supabase] Não foi possível carregar lista de brokers — cliente indisponível")
        return []

    try:
        resp = (cliente.table('rafi_brokers')
                       .select('id,nome,health_score,health_estado,allocation_pct,broker_priority')
                       .eq('enabled', True)
                       .execute())
        return resp.data or []
    except Exception as e:
        logger.error(f"[Supabase] Erro ao carregar brokers habilitados: {e}")
        return []


# ── Upload de dados para Supabase Storage ─────────────────────────────────────

def verificar_upload_pendente() -> Optional[dict]:
    """
    Verifica se há uma solicitação de upload de dados pendente no dashboard.

    Retorna dict com {id, arquivo, broker} ou None se não houver pendência.
    O status 'pending' é criado pelo admin dashboard e consumido aqui.
    """
    cliente = _get_cliente()
    if cliente is None:
        return None

    try:
        res = (
            cliente.table('rafi_uploads')
            .select('id,arquivo,broker')
            .eq('status', 'pending')
            .order('created_at')
            .limit(1)
            .execute()
        )
        if not res.data:
            return None

        row = res.data[0]
        logger.info(f"[Supabase] Upload de dados pendente: {row.get('arquivo')} (broker: {row.get('broker')})")
        return row
    except Exception as e:
        logger.debug(f"[Supabase] Erro ao verificar upload pendente: {e}")
        return None


def atualizar_status_upload(upload_id: str, status: str,
                            progress_pct: int = 0,
                            storage_path: Optional[str] = None,
                            tamanho_bytes: Optional[int] = None,
                            error_msg: Optional[str] = None) -> bool:
    """
    Atualiza o status de uma linha em rafi_uploads.

    status: 'pending' | 'running' | 'done' | 'error'
    """
    cliente = _get_cliente()
    if cliente is None:
        return False

    try:
        campos: dict = {
            'status':       status,
            'progress_pct': progress_pct,
            'updated_at':   datetime.utcnow().isoformat(),
        }
        if storage_path is not None:
            campos['storage_path'] = storage_path
        if tamanho_bytes is not None:
            campos['tamanho_bytes'] = tamanho_bytes
        if error_msg is not None:
            campos['error_msg'] = error_msg

        (cliente.table('rafi_uploads')
                .update(campos)
                .eq('id', upload_id)
                .execute())
        return True
    except Exception as e:
        logger.error(f"[Supabase] Erro ao atualizar status upload: {e}")
        return False


# ── Download de dados do Supabase Storage ─────────────────────────────────────

def baixar_dados_storage(
    broker:  str = 'pepperstone',
    destino: str = 'data/EURUSD_M5.csv',
) -> bool:
    """
    Baixa o CSV de dados históricos comprimido do Supabase Storage e
    descomprime para `destino`.

    O arquivo fica em: backtest-data/<broker>_EURUSD_M5.csv.gz
    Requer SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY no ambiente (não usa
    a chave anon — o bucket backtest-data é privado).

    Retorna True se o download e descompressão foram bem-sucedidos.
    """
    import gzip
    import shutil
    import requests as _req

    url_base = os.getenv('SUPABASE_URL', '').rstrip('/')
    key      = os.getenv('SUPABASE_SERVICE_ROLE_KEY', '') or os.getenv('SUPABASE_KEY', '')

    if not url_base or not key or 'xxxx' in url_base:
        logger.error("[Storage] SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não configuradas")
        return False

    caminho_storage = f"{broker}_EURUSD_M5.csv.gz"
    url_download    = f"{url_base}/storage/v1/object/backtest-data/{caminho_storage}"
    headers         = {
        'Authorization': f'Bearer {key}',
        'apikey':        key,
    }

    os.makedirs(os.path.dirname(os.path.abspath(destino)), exist_ok=True)
    caminho_gz = destino + '.gz'

    logger.info(f"[Storage] Baixando {caminho_storage} → {destino}")

    try:
        resp = _req.get(url_download, headers=headers, stream=True, timeout=300)
        if resp.status_code != 200:
            logger.error(
                f"[Storage] Erro HTTP {resp.status_code}: {resp.text[:300]}"
            )
            return False

        tamanho_total = int(resp.headers.get('content-length', 0))
        baixado = 0
        with open(caminho_gz, 'wb') as f:
            for chunk in resp.iter_content(chunk_size=4 * 1024 * 1024):
                if chunk:
                    f.write(chunk)
                    baixado += len(chunk)
                    if tamanho_total:
                        pct = baixado / tamanho_total * 100
                        logger.info(f"[Storage] Download: {baixado/1e6:.1f} MB / {tamanho_total/1e6:.1f} MB ({pct:.0f}%)")

        logger.info(f"[Storage] Download concluído: {baixado/1e6:.1f} MB → descomprimindo...")

        with gzip.open(caminho_gz, 'rb') as gz_in, open(destino, 'wb') as csv_out:
            shutil.copyfileobj(gz_in, csv_out)

        tamanho_csv = os.path.getsize(destino)
        logger.info(f"[Storage] CSV pronto: {destino} ({tamanho_csv/1e6:.1f} MB)")

    except Exception as e:
        logger.error(f"[Storage] Falha no download: {e}")
        return False
    finally:
        # Remove o arquivo .gz temporário
        try:
            if os.path.exists(caminho_gz):
                os.remove(caminho_gz)
        except Exception:
            pass

    return True
