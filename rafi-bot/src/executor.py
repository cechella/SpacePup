"""
executor.py — Loop principal do Bot RAFI

Ciclo a cada candle M5 fechado:
  1. Obtém últimos candles do MT5
  2. Calcula RAFI + BB + S/R
  3. Verifica sinal de entrada (rompimento válido)
  4. Se sinal: calcula lote, envia ordem com SL/TP
  5. Sincroniza com Supabase (admin dashboard)
  6. Monitora posições abertas — fecha em exaustão

Uso:
  python -m src.executor                    (usa config.yaml)
  python -m src.executor --config prod.yaml (arquivo diferente)

Variáveis de ambiente (obrigatórias para sincronização com dashboard):
  SUPABASE_URL=https://xxxx.supabase.co
  SUPABASE_KEY=eyJhbGci...

Kill switch: pressione Ctrl+C ou crie o arquivo STOP na pasta raiz.
"""

import hashlib
import json
import os
import subprocess
import sys
import time
import logging
import argparse
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import yaml
import numpy as np

# ── Módulos internos ──────────────────────────────────────────────────────────
from .mt5_client   import ClienteMT5
from .indicators   import (
    calcular_indice_forca,
    calcular_bollinger,
    detectar_pivotos,
    niveis_sr_ativos,
    rompimento_ocorreu,
)
from .risk_manager import lote_por_faixa, SupabaseIndisponivel
from .ml.predictor import filtrar_sinal, MonitorPerformance, modelo_info
from .supabase_sync import (
    sincronizar_trade,
    atualizar_resultado,
    publicar_heartbeat,
    verificar_comando_parar,
    publicar_candle,
    publicar_candles_batch,
    verificar_comando_avancado,
    publicar_log,
    carregar_config_supabase,
    carregar_broker_ativo,
    carregar_credenciais_broker,
    publicar_status_broker,
    gravar_rafi_trade,
    verificar_backtest_pendente,
    atualizar_backtest_run,
    publicar_config_hash_startup,
    verificar_upload_pendente,
    atualizar_status_upload,
)
from . import supabase_sync as _supabase_sync_mod
from .broker_coordinator import BrokerCoordinator

# ── Configuração de logging ───────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)-8s | %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler('logs/rafi_bot.log', encoding='utf-8'),
    ],
)
logger = logging.getLogger(__name__)

# ── Constantes ────────────────────────────────────────────────────────────────
ARQUIVO_STOP = Path('STOP')           # crie este arquivo para parar o bot
INTERVALO_S  = 5                      # segundos entre verificações de candle
MAGIC_NUMBER = 20250101               # identificador das ordens do bot no MT5

# Parâmetros obrigatórios: devem existir no config.yaml (ou serem sobrepostos pelo Supabase).
# O bot não inicia se algum estiver ausente — evita valores fantasmas embutidos no código.
PARAMS_OBRIGATORIOS = [
    'estrategia_modo',
    'sr_lookback', 'swing_stop_lookback',
    'ma_rapida', 'ma_lenta', 'ma_threshold',
    'forca_limiar',
    'bb_periodo', 'bb_desvios', 'bb_filtro_ativo',
    'bb_limiar_estreita', 'bb_squeeze_expansao_min',
    'autoscan_min_breakout', 'autoscan_min_gap_candles', 'autoscan_stop_offset',
    'ratio_risco_retorno', 'max_trades_simultaneos', 'risco_maximo_diario',
]


def carregar_config(caminho: str = 'config.yaml') -> dict:
    """Carrega e retorna o arquivo de configuração YAML."""
    with open(caminho, 'r', encoding='utf-8') as f:
        return yaml.safe_load(f)


def calcular_hash_config(cfg: dict) -> str:
    """
    Retorna hash MD5 de 8 chars do config efetivo (pós-overrides do Supabase).

    Permite verificar no dashboard se o bot ao vivo usa os mesmos parâmetros
    do backtest que gerou os resultados históricos.
    """
    # Serializa exatamente os campos salvos no Supabase pelo dashboard
    # (deve ser idêntico a CAMPOS_CONFIG em rafi-dashboard/app/api/config/route.ts)
    CHAVES = [
        'estrategia_modo', 'forca_limiar', 'rafi_periodo', 'sr_lookback',
        'swing_stop_lookback', 'ma_rapida', 'ma_lenta', 'ma_threshold',
        'bb_filtro_ativo', 'bb_limiar_estreita', 'bb_periodo', 'bb_desvios',
        'ratio_risco_retorno', 'max_trades_simultaneos',
        'autoscan_min_breakout', 'autoscan_min_gap_candles',
        'autoscan_stop_offset', 'bb_squeeze_expansao_min',
    ]
    snapshot = {k: cfg.get(k) for k in CHAVES}

    def _val(v: object) -> str:
        """Serializa um valor exatamente como JSON.stringify do JavaScript.
        Python serializa float 0.00005 como '5e-05'; JS serializa como '0.00005'.
        O format :.10f + rstrip garante compatibilidade para todos os valores do config."""
        if v is None:            return 'null'
        if isinstance(v, bool):  return 'true' if v else 'false'
        if isinstance(v, int):   return str(v)
        if isinstance(v, float): return f'{v:.10f}'.rstrip('0').rstrip('.')
        if isinstance(v, str):   return json.dumps(v, ensure_ascii=False)
        return json.dumps(v, ensure_ascii=False)

    partes = ','.join(
        f'{json.dumps(k, ensure_ascii=False)}:{_val(snapshot[k])}'
        for k in sorted(snapshot)
    )
    serializado = '{' + partes + '}'
    return hashlib.md5(serializado.encode()).hexdigest()[:8]


def aguardar_fechamento_candle(tf_segundos: int = 300) -> None:
    """
    Aguarda até o fechamento do próximo candle M5 (5min = 300s).

    Dorme até o próximo múltiplo de `tf_segundos` em UTC.
    Isso garante que a decisão seja feita APÓS o fechamento do candle,
    evitando lookahead bias.
    """
    agora = time.time()
    proximo = (int(agora / tf_segundos) + 1) * tf_segundos
    espera  = proximo - agora
    logger.info(f"Aguardando fechamento do candle M5 em {espera:.0f}s...")
    time.sleep(max(1, espera))


class RafiBot:
    """
    Orquestrador principal do bot RAFI.

    Gerencia o ciclo de vida: conexão MT5 → análise → ordem → sync.
    """

    def __init__(self, config: dict):
        self.cfg     = config
        self.par     = config['par']                          # 'EURUSD#' na XM
        self.mt5     = ClienteMT5(config)
        self.capital = config.get('capital_inicial', 100.0)

        # Aplica o nível de log definido no config (padrão INFO; use DEBUG para diagnóstico autoscan)
        nivel_log = config.get('log_nivel', 'INFO').upper()
        logging.getLogger().setLevel(getattr(logging, nivel_log, logging.INFO))

        # Rastreia trades abertos: {ticket: {ts, entry, sl, tp, lot}}
        # Preenchido no startup via _restaurar_posicoes_abertas() para sobreviver a reinícios.
        self._posicoes: dict = {}

        # Controle de perda diária e P&L acumulado do dia
        self._perda_hoje    = 0.0
        self._pnl_hoje      = 0.0
        self._data_hoje     = datetime.utcnow().date()

        # Info da conta MT5 (preenchida no conectar)
        self._conta_account = 0
        self._conta_server  = ''

        # Timestamp (Unix) do último sinal emitido em modo autoscan — controla gap mínimo
        self._autoscan_ultimo_ts: int = 0

        # ── Estado de diagnóstico do ciclo (reiniciado a cada análise) ───────────
        self._ultimo_motivo_rejeicao: str = ''   # publicado no log "sem sinal"
        self._forming_signal:    bool  = False   # sinal em formação
        self._forming_direction: str   = 'buy'
        self._forming_rafi:      float = 0.0
        self._forming_tf_count:  int   = 0
        self._forming_bb_open:   bool  = False
        self._forming_price:     float = 0.0

        # Sobrescreve config.yaml com valores salvos no dashboard (/admin/config)
        cfg_supa = carregar_config_supabase(profile='live')
        if cfg_supa:
            MAPA = {
                # Modo da estratégia — OBRIGATÓRIO para trocar entre rafi/autoscan pelo dashboard
                'estrategia_modo': 'estrategia_modo',
                # Parâmetros do modo RAFI
                'forca_limiar': 'forca_limiar', 'rafi_periodo': 'rafi_periodo',
                'sr_lookback': 'sr_lookback', 'swing_stop_lookback': 'swing_stop_lookback',
                'ma_rapida': 'ma_rapida', 'ma_lenta': 'ma_lenta', 'ma_threshold': 'ma_threshold',
                'bb_filtro_ativo': 'bb_filtro_ativo', 'bb_limiar_estreita': 'bb_limiar_estreita',
                'bb_periodo': 'bb_periodo', 'bb_desvios': 'bb_desvios',
                # Parâmetros exclusivos do modo Autoscan (réplica do browser)
                'autoscan_min_breakout':    'autoscan_min_breakout',    # pip mínimo além do S/R
                'autoscan_min_gap_candles': 'autoscan_min_gap_candles', # gap entre sinais
                'autoscan_stop_offset':     'autoscan_stop_offset',     # buffer do stop (pip)
                'autoscan_sr_lookback':     'autoscan_sr_lookback',     # S/R lookback autoscan (10)
                'bb_squeeze_expansao_min':  'bb_squeeze_expansao_min',  # expansão mín. da BB
                # Gestão de risco — comuns a todos os modos
                'risco_por_trade': 'risco_por_trade', 'ratio_risco_retorno': 'ratio_risco_retorno',
                'max_trades_simultaneos': 'max_trades_simultaneos',
                'risco_maximo_diario': 'risco_maximo_diario',
            }
            for chave_supa, chave_cfg in MAPA.items():
                if chave_supa in cfg_supa and cfg_supa[chave_supa] is not None:
                    self.cfg[chave_cfg] = cfg_supa[chave_supa]
            logger.info("Config carregada do Supabase (dashboard /admin/config)")

        # Valida que todos os parâmetros obrigatórios estão presentes (Admin → Supabase → config.yaml).
        # Falha rápida: melhor abortar com mensagem clara do que operar com valor embutido silencioso.
        ausentes = [p for p in PARAMS_OBRIGATORIOS if p not in self.cfg or self.cfg[p] is None]
        if ausentes:
            raise ValueError(
                f"Parâmetros obrigatórios ausentes no config (verifique config.yaml / Admin Panel): "
                f"{ausentes}"
            )

        # Broker ativo: lê do Supabase qual corretora está habilitada
        # --broker xm | --broker pepperstone seleciona qual usar quando múltiplas estão ativas
        broker_id_arg = config.get('_broker_arg')  # injetado por main() via --broker
        broker_supa   = carregar_broker_ativo(broker_id=broker_id_arg)
        if broker_supa:
            bid    = broker_supa['id']
            creds  = config.get('corretoras', {}).get(bid, {})
            self._broker_id = bid
            # Credenciais: Supabase (admin dashboard) tem prioridade; fallback para config.yaml
            supa_creds = carregar_credenciais_broker(bid) or {}
            self._broker_login    = supa_creds.get('mt5_login')    or creds.get('login')
            self._broker_senha    = supa_creds.get('mt5_senha')    or creds.get('senha')
            self._broker_servidor = supa_creds.get('mt5_servidor') or broker_supa.get('servidor') or creds.get('servidor')
            # Caminho do terminal64.exe do broker — necessário quando múltiplos MT5 rodam simultaneamente
            self._broker_mt5_path = supa_creds.get('mt5_path')    or creds.get('mt5_path')
            # Símbolo correto por corretora (EURUSD# vs EURUSD)
            self.par            = supa_creds.get('mt5_simbolo') or broker_supa.get('simbolo') or creds.get('simbolo') or self.par
            self.cfg['par']     = self.par
            self.mt5.par        = self.par
            logger.info(f"Broker ativo (Supabase): {bid} | Símbolo: {self.par}")
            if self._broker_mt5_path:
                logger.info(f"MT5 path: {self._broker_mt5_path}")
        else:
            # Fallback: usa o par do config.yaml sem autenticação separada
            self._broker_id       = config.get('corretora', 'pepperstone').lower()
            self._broker_login    = None
            self._broker_senha    = None
            self._broker_servidor = None
            self._broker_mt5_path = None
            logger.warning("rafi_brokers indisponível — usando par do config.yaml (fallback)")

        # Monitor de performance ML — rastreia WR/PF rolling e aciona retreino
        self._monitor = MonitorPerformance(
            janela     = 20,
            wr_minimo  = 0.70,
            pf_minimo  = 2.0,
        )

        # Contadores ML por dia — resetam junto com _pnl_hoje (meia-noite)
        self._ml_sinais_hoje    = 0
        self._ml_aprovados_hoje = 0

        # Sinaliza ao loop principal para reiniciar (comando 'restart' do dashboard)
        self._deve_reiniciar = False

        # Último RAFI calculado — passado ao candle em formação para manter gauge atualizado
        self._ultimo_rafi: Optional[float] = None

        # Controle de backtest em background (evita dois simultâneos)
        self._backtest_em_andamento = False

        # Controle de upload de dados em background (evita dois simultâneos)
        self._upload_em_andamento = False

        # Hash do config efetivo (pós-overrides) — exibido no dashboard para rastreabilidade
        self._config_hash = calcular_hash_config(self.cfg)
        # Força gravação do hash no Supabase via UPDATE dedicado (não depende do heartbeat)
        publicar_config_hash_startup(self._config_hash)

        # ── Broker Health Engine ──────────────────────────────────────────────
        # Coordenador de saúde do broker — inicia telemetria em background e
        # avalia o estado operacional a cada ciclo de candle.
        # Inicializado aqui mas só ativado (iniciar()) após a conexão MT5.
        self._health = BrokerCoordinator(
            broker_id=self._broker_id,
            mt5_client=self.mt5,
            simbolo=self.par,
            supabase_sync=_supabase_sync_mod,
        )

        # Informa status do modelo ML no startup
        info_ml = modelo_info()
        if info_ml.get('disponivel'):
            logger.info(
                f"Modelo ML carregado | Trades treino: {info_ml['n_trades']:,} | "
                f"WR histórico: {info_ml['wr_historico']:.1%} | "
                f"Threshold: {info_ml['threshold']:.0%}"
            )
        else:
            logger.info("Modelo ML não encontrado — bot opera sem filtro ML até primeiro treino")

        logger.info(f"RafiBot iniciado | Par: {self.par} | Capital: ${self.capital:.2f} | Config: {self._config_hash}")

    # ─────────────────────────────────────────────────────────────────────────
    # LOOP PRINCIPAL
    # ─────────────────────────────────────────────────────────────────────────

    def rodar(self) -> None:
        """
        Inicia o loop principal — roda até Ctrl+C ou arquivo STOP.

        Ciclo a cada candle M5 fechado.
        """
        logger.info("=" * 60)
        logger.info("BOT RAFI INICIADO — pressione Ctrl+C para parar")
        logger.info(f"Kill switch: crie o arquivo '{ARQUIVO_STOP}' na pasta raiz")
        logger.info("=" * 60)

        publicar_log(f"Bot RAFI iniciado — conectando ao MT5 ({self._broker_id})", level='info')
        if not self.mt5.conectar(
            login     = self._broker_login,
            senha     = self._broker_senha,
            servidor  = self._broker_servidor,
            mt5_path  = self._broker_mt5_path,
        ):
            logger.error("Não foi possível conectar ao MT5. Verifique o terminal.")
            publicar_log("ERRO: Não foi possível conectar ao MT5", level='error')
            return

        # Captura informações da conta após conectar
        try:
            import MetaTrader5 as _mt5
            info = _mt5.account_info()
            if info:
                self._conta_account = info.login
                self._conta_server  = info.server
        except Exception:
            pass

        saldo_real = self.mt5.capital_atual()
        if saldo_real is not None:
            self.capital = saldo_real   # usa saldo real mesmo que seja $0
        logger.info(f"Saldo da conta: ${self.capital:.2f}")

        # Restaura posições que estavam abertas antes de um eventual reinício
        self._restaurar_posicoes_abertas()

        # Inicia o Broker Health Engine (telemetria em background + estado inicial)
        try:
            self._health.iniciar()
            logger.info(f"[{self._broker_id}] Broker Health Engine iniciado")
        except RuntimeError as e:
            logger.error(f"HALT: {e}")
            publicar_log(f"HALT: Broker Health Engine não iniciou — {e}", level='error')
            self.mt5.desconectar()
            return

        # Publica histórico inicial para o gráfico do dashboard aparecer imediatamente
        df_inicial = self.mt5.obter_candles('M5', n_candles=200)
        if df_inicial is not None:
            self._publicar_historico_inicial(df_inicial)

        try:
            while True:
                # Kill switch por arquivo
                if ARQUIVO_STOP.exists():
                    logger.info("Arquivo STOP detectado — encerrando bot.")
                    break

                # Kill switch por comando do dashboard
                if verificar_comando_parar():
                    logger.info("Comando STOP recebido via dashboard — encerrando bot.")
                    publicar_heartbeat('stopped', self.capital, self.capital, 0,
                                       pnl_hoje=self._pnl_hoje,
                                       par=self.par, server=self._conta_server,
                                       account=self._conta_account,
                                       config_hash=self._config_hash)
                    break

                # Comandos avançados do dashboard (fechar posição, ordem manual, restart)
                cmd = verificar_comando_avancado()
                if cmd:
                    self._processar_comando_avancado(cmd)

                # Reinicialização solicitada via dashboard
                if self._deve_reiniciar:
                    logger.info("Comando RESTART recebido — encerrando para reinicialização.")
                    publicar_heartbeat('stopped', self.capital, self.capital, 0,
                                       pnl_hoje=self._pnl_hoje,
                                       par=self.par, server=self._conta_server,
                                       account=self._conta_account,
                                       config_hash=self._config_hash)
                    break

                # Reset diário
                self._verificar_reset_diario()

                # Ciclo de health do broker (avalia score e estado a cada candle M5)
                try:
                    self._health.executar_ciclo_health()
                except RuntimeError as e:
                    logger.error(f"HALT por indisponibilidade do Supabase: {e}")
                    publicar_log(f"HALT: {e}", level='error')
                    break

                # Ciclo principal
                try:
                    self._ciclo()
                except SupabaseIndisponivel as e:
                    logger.error(f"HALT por indisponibilidade do Supabase (faixas de lote): {e}")
                    publicar_log(f"HALT: {e}", level='error')
                    break

                # Verifica backtest solicitado pelo admin (roda em thread separada)
                if not self._backtest_em_andamento:
                    _bt_pendente = verificar_backtest_pendente()
                    if _bt_pendente:
                        self._iniciar_backtest_background(_bt_pendente)

                # Verifica upload de dados solicitado pelo admin (roda em thread separada)
                if not self._upload_em_andamento:
                    _upload_pendente = verificar_upload_pendente()
                    if _upload_pendente:
                        self._iniciar_upload_background(_upload_pendente)

                # Aguarda próximo candle M5, publicando candle em formação a cada 30s
                agora   = time.time()
                proximo = (int(agora / 300) + 1) * 300
                espera  = proximo - agora
                logger.info(f"Aguardando fechamento do candle M5 em {espera:.0f}s...")
                while time.time() < proximo - 1:
                    time.sleep(min(30, max(1, proximo - time.time())))
                    if time.time() < proximo - 1:
                        # Heartbeat periódico para manter dashboard online
                        publicar_heartbeat(
                            status         = 'waiting',
                            balance        = self.capital,
                            equity         = self.mt5.equity_atual() or self.capital,
                            open_positions = len(self.mt5.posicoes_abertas()),
                            pnl_hoje       = self._pnl_hoje,
                            par            = self.par,
                            server         = self._conta_server,
                            account        = self._conta_account,
                            config_hash    = self._config_hash,
                            forming_rafi   = self._ultimo_rafi,
                        )
                        # Candle em formação: atualiza o gráfico entre fechamentos M5
                        # Inclui o RAFI do último candle fechado para manter o gauge atualizado
                        candle_formando = self.mt5.obter_candle_formando()
                        if candle_formando:
                            publicar_candle(
                                time_unix  = candle_formando['time'],
                                open_price = candle_formando['open'],
                                high       = candle_formando['high'],
                                low        = candle_formando['low'],
                                close      = candle_formando['close'],
                                volume     = candle_formando['volume'],
                                rafi       = self._ultimo_rafi,
                            )

        except KeyboardInterrupt:
            logger.info("Ctrl+C — encerrando bot.")
        finally:
            self._health.parar()
            self.mt5.desconectar()
            logger.info("Bot encerrado.")

    # ─────────────────────────────────────────────────────────────────────────
    # BACKTEST REMOTO (disparado pelo admin dashboard)
    # ─────────────────────────────────────────────────────────────────────────

    def _iniciar_backtest_background(self, run: dict) -> None:
        """
        Executa um backtest em thread daemon para não bloquear o loop de trading.

        run: dict com {id, periodo, inicio, fim, capital, profile} do Supabase.
        Ao terminar, grava o resultado em rafi_backtest_runs.
        """
        # Candles M5 por período (com margem de sessão/fim de semana)
        PERIODO_CANDLES = {
            '1w': 2500, '1m': 9000, '3m': 27000, '6m': 54000, '1y': 108000, '5y': 270000,
        }

        def _worker() -> None:
            run_id = run['id']
            try:
                self._backtest_em_andamento = True
                atualizar_backtest_run(run_id, 'running', progress=5)
                periodo   = run.get('periodo', '1m')
                n_candles = PERIODO_CANDLES.get(periodo, 9000)
                logger.info(f"[Backtest] Run {run_id[:8]} | período: {periodo} | {n_candles:,} candles")
                publicar_log(f"Backtest iniciado | período: {periodo}", level='info')

                # Config: cópia do atual + override do perfil solicitado
                profile   = run.get('profile', 'simulator')
                cfg_run   = dict(self.cfg)
                cfg_supa  = carregar_config_supabase(profile=profile)
                if cfg_supa:
                    for k in [
                        'estrategia_modo', 'forca_limiar', 'rafi_periodo', 'sr_lookback',
                        'swing_stop_lookback', 'ma_rapida', 'ma_lenta', 'ma_threshold',
                        'bb_filtro_ativo', 'bb_limiar_estreita', 'bb_periodo', 'bb_desvios',
                        'autoscan_min_breakout', 'autoscan_min_gap_candles',
                        'autoscan_stop_offset', 'autoscan_sr_lookback', 'bb_squeeze_expansao_min',
                        'ratio_risco_retorno', 'max_trades_simultaneos',
                    ]:
                        if k in cfg_supa and cfg_supa[k] is not None:
                            cfg_run[k] = cfg_supa[k]

                # Override de R:R via campo rr_override do job (UI admin)
                rr_override = run.get('rr_override')
                if rr_override is not None:
                    cfg_run['ratio_risco_retorno'] = float(rr_override)
                    logger.info(f"[Backtest] R:R override: {rr_override}")

                # Corretora solicitada (informacional — usa o terminal MT5 ativo do bot)
                broker_req = run.get('broker', 'auto')
                broker_ativo = self.cfg.get('corretora', 'auto')
                if broker_req not in ('auto', broker_ativo):
                    logger.warning(
                        f"[Backtest] Corretora solicitada '{broker_req}' difere da ativa '{broker_ativo}'. "
                        "Usando dados do terminal MT5 ativo."
                    )
                logger.info(f"[Backtest] Corretora: {broker_req} | Terminal ativo: {broker_ativo}")

                capital = float(run.get('capital') or cfg_run.get('capital_inicial', 20.0))
                cfg_run['capital_inicial'] = capital
                config_hash = calcular_hash_config(cfg_run)
                atualizar_backtest_run(run_id, 'running', config_hash=config_hash, progress=15)

                # Dados históricos — MT5 ativo, Storage ou terminal alternativo
                usar_mt5_direto = broker_req in ('auto', None, broker_ativo)
                if usar_mt5_direto:
                    logger.info(f"[Backtest] Buscando {n_candles:,} candles M5 do MT5 ativo ({broker_ativo})...")
                    df_m5 = self.mt5.obter_candles('M5', n_candles=n_candles)
                    if df_m5 is None or df_m5.empty:
                        raise RuntimeError("MT5 não retornou dados — verifique a conexão")
                else:
                    # Tenta Supabase Storage primeiro (arquivo histórico completo)
                    # e só spawna subprocess MT5 se o Storage não tiver o arquivo.
                    temp_csv = os.path.abspath(
                        os.path.join(os.path.dirname(__file__), '..', 'data',
                                     f'bt_temp_{run_id[:8]}.csv')
                    )
                    atualizar_backtest_run(run_id, 'running', progress=20)

                    storage_ok = False
                    try:
                        from src.supabase_sync import baixar_dados_storage
                        logger.info(f"[Backtest] Tentando Storage para '{broker_req}'…")
                        storage_ok = baixar_dados_storage(broker=broker_req, destino=temp_csv)
                    except Exception as e_st:
                        logger.warning(f"[Backtest] Storage indisponível: {e_st}")

                    if not storage_ok:
                        # Fallback: subprocess que conecta ao terminal MT5 da corretora
                        import subprocess
                        script_dl = os.path.abspath(
                            os.path.join(os.path.dirname(__file__), '..', 'scripts', 'baixar_dados.py')
                        )
                        logger.info(f"[Backtest] Baixando dados da {broker_req} via MT5 subprocess → {temp_csv}")
                        proc = subprocess.run(
                            [sys.executable, script_dl,
                             '--broker', broker_req,
                             '--output', temp_csv],
                            capture_output=True, text=True, timeout=300,
                            cwd=os.path.dirname(script_dl),
                        )
                        if proc.returncode != 0:
                            detalhe = (proc.stderr or proc.stdout or '')[-600:]
                            raise RuntimeError(
                                f"Falha ao baixar dados da {broker_req}: {detalhe}"
                            )
                        logger.info(f"[Backtest] Download {broker_req} (MT5) concluído: {temp_csv}")

                    from backtest.engine import BacktestCSV
                    df_m5 = BacktestCSV._carregar_csv(temp_csv)
                    try:
                        os.remove(temp_csv)
                    except Exception:
                        pass
                    if df_m5 is None or df_m5.empty:
                        raise RuntimeError(f"CSV da {broker_req} vazio após download")

                # Filtro de período (--inicio / --fim)
                import pandas as pd
                inicio_str = run.get('inicio')
                fim_str    = run.get('fim')
                if inicio_str:
                    df_m5 = df_m5[df_m5.index >= pd.Timestamp(str(inicio_str), tz='UTC')]
                if fim_str:
                    dt_fim = pd.Timestamp(str(fim_str), tz='UTC') + pd.Timedelta(hours=23, minutes=59)
                    df_m5 = df_m5[df_m5.index <= dt_fim]
                if df_m5.empty:
                    raise RuntimeError("Nenhum dado no período selecionado")

                # Reamostrar M15 do M5
                df_m15 = df_m5.resample('15min').agg({
                    'open': 'first', 'high': 'max', 'low': 'min',
                    'close': 'last', 'volume': 'sum',
                }).dropna()
                atualizar_backtest_run(run_id, 'running', progress=35)

                # Executar backtest
                import sys as _sys
                _sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
                from backtest.engine import Backtest
                from backtest.report import gerar_relatorio
                bt     = Backtest(cfg_run, df_m5, df_m15, capital=capital)
                atualizar_backtest_run(run_id, 'running', progress=40)
                trades = bt.executar()
                atualizar_backtest_run(run_id, 'running', progress=85)

                relatorio = gerar_relatorio(trades, capital_inicial=capital,
                                            equity_curve=bt.equity_curve)

                # Simplificar trades para JSON (≤500 registros)
                trades_simples = []
                for t in trades[:500]:
                    ts_ent = t.get('timestamp_entrada')
                    trades_simples.append({
                        'ts':      int(ts_ent.timestamp()) if ts_ent else 0,
                        'dir':     t.get('sinal', ''),
                        'entry':   round(t.get('preco_entrada', 0), 5),
                        'sl':      round(t.get('stop_loss', 0), 5),
                        'tp':      round(t.get('take_profit', 0), 5),
                        'pnl':     round(t.get('pnl_usd', 0), 2),
                        'pips':    round(t.get('variacao_pips', 0), 1),
                        'motivo':  t.get('motivo_saida', ''),
                        'rafi':    round(t.get('forca_entrada', 0), 2) if t.get('forca_entrada') else None,
                        'dur_c':   t.get('duracao_candles', 0),
                    })

                atualizar_backtest_run(
                    run_id, 'done',
                    config_hash=config_hash,
                    progress=100,
                    resultado=relatorio,
                    trades_json=trades_simples,
                )
                wr = relatorio.get('win_rate_pct', 0)
                pf = relatorio.get('profit_factor', 0)
                logger.info(f"[Backtest] Run {run_id[:8]} concluído | WR: {wr:.1f}% | PF: {pf:.3f} | {len(trades)} trades")
                publicar_log(f"Backtest concluído | WR: {wr:.1f}% | PF: {pf:.3f} | {len(trades)} trades", level='info')

            except Exception as exc:
                logger.error(f"[Backtest] Erro no run {run_id}: {exc}")
                atualizar_backtest_run(run_id, 'error', error_msg=str(exc))
                publicar_log(f"Backtest erro: {exc}", level='error')
            finally:
                self._backtest_em_andamento = False

        t = threading.Thread(target=_worker, daemon=True, name=f'bt-{run["id"][:8]}')
        t.start()

    # ─────────────────────────────────────────────────────────────────────────
    # UPLOAD DE DADOS PARA SUPABASE STORAGE (disparado pelo admin dashboard)
    # ─────────────────────────────────────────────────────────────────────────

    def _iniciar_upload_background(self, solicitacao: dict) -> None:
        """
        Executa o upload de dados históricos em thread daemon para não bloquear o trading.

        solicitacao: dict com {id, arquivo, broker} do Supabase (rafi_uploads).
        Chama o script upload_dados_supabase.py como subprocesso para reaproveitar
        toda a lógica de compressão e upload já implementada nele.
        """

        def _worker() -> None:
            upload_id = solicitacao['id']
            broker    = solicitacao.get('broker', 'pepperstone')
            try:
                self._upload_em_andamento = True
                atualizar_status_upload(upload_id, 'running', progress_pct=2)
                logger.info(f"[Upload] Iniciando upload de dados (broker: {broker})")
                publicar_log(f"Upload de dados iniciado para Supabase Storage (broker: {broker})", level='info')

                # Localiza o script relativo à raiz do rafi-bot
                script = Path(__file__).parent.parent / 'scripts' / 'upload_dados_supabase.py'
                if not script.exists():
                    raise FileNotFoundError(f"Script não encontrado: {script}")

                # Passa SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY do ambiente atual
                env = os.environ.copy()
                # Garante que a key correta está disponível (supabase_sync usa SUPABASE_KEY)
                if 'SUPABASE_SERVICE_ROLE_KEY' not in env and 'SUPABASE_KEY' in env:
                    env['SUPABASE_SERVICE_ROLE_KEY'] = env['SUPABASE_KEY']

                cmd = [
                    sys.executable, str(script),
                    '--broker',    broker,
                    '--upload-id', upload_id,
                ]
                logger.info(f"[Upload] Executando: {' '.join(cmd)}")

                proc = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    env=env,
                )

                # Loga saída linha a linha para acompanhamento
                for linha in proc.stdout:
                    logger.info(f"[Upload] {linha.rstrip()}")

                proc.wait()
                if proc.returncode != 0:
                    raise RuntimeError(f"Script de upload encerrou com código {proc.returncode}")

                logger.info("[Upload] Upload concluído com sucesso")
                publicar_log("Upload de dados concluído — arquivo disponível no Supabase Storage", level='info')

            except Exception as exc:
                logger.error(f"[Upload] Erro: {exc}")
                atualizar_status_upload(upload_id, 'error', error_msg=str(exc)[:500])
                publicar_log(f"Erro no upload de dados: {exc}", level='error')
            finally:
                self._upload_em_andamento = False

        t = threading.Thread(target=_worker, daemon=True, name=f'upload-{solicitacao["id"][:8]}')
        t.start()

    # ─────────────────────────────────────────────────────────────────────────
    # CICLO POR CANDLE
    # ─────────────────────────────────────────────────────────────────────────

    def _ciclo(self) -> None:
        """Executa um ciclo completo de análise e decisão."""
        logger.debug("─── Novo ciclo ───")

        # 1. Atualiza capital
        cap_atual = self.mt5.capital_atual()
        if cap_atual is not None:
            self.capital = cap_atual

        # 2. Verifica posições abertas (exaustão / SL/TP atingido)
        self._monitorar_posicoes()

        # 3. Publica heartbeat no Supabase (atualiza dashboard)
        posicoes_abertas_hb = self.mt5.posicoes_abertas()
        if self._limite_diario_atingido():
            status_hb = 'stopped'
        elif posicoes_abertas_hb:
            status_hb = 'running'
        else:
            status_hb = 'waiting'
        _info_ml   = modelo_info()
        _status_ml = self._monitor.status()
        publicar_heartbeat(
            status         = status_hb,
            balance        = self.capital,
            equity         = self.mt5.equity_atual() or self.capital,
            open_positions = len(posicoes_abertas_hb),
            pnl_hoje       = self._pnl_hoje,
            par            = self.par,
            server         = self._conta_server,
            account        = self._conta_account,
            config_hash    = self._config_hash,
            broker_id      = self._broker_id,   # cada broker escreve na sua linha
            # ML status
            ml_modelo_carregado = _info_ml.get('disponivel', False),
            ml_modo             = _status_ml.get('modo', 'OBSERVAÇÃO'),
            ml_wr_rolling       = _status_ml.get('wr_rolling'),
            ml_pf_rolling       = _status_ml.get('pf_rolling'),
            ml_sinais_hoje      = self._ml_sinais_hoje,
            ml_aprovados_hoje   = self._ml_aprovados_hoje,
            ml_treinado_em      = _info_ml.get('treinado_em') or None,
            ml_threshold        = _info_ml.get('threshold', 0.65),
        )
        # Atualiza card da corretora no /admin/brokers (valida terminal correto)
        publicar_status_broker(
            broker_id      = self._broker_id,
            saldo          = self.capital,
            posicoes       = len(posicoes_abertas_hb),
            pnl_hoje       = self._pnl_hoje,
            status_text    = ('OPERANDO' if posicoes_abertas_hb
                              else 'PARADO' if self._limite_diario_atingido()
                              else 'AGUARDANDO SINAL'),
            servidor_real  = self._conta_server,  # valida terminal MT5
        )

        # 4. Verifica limite diário de perda
        if self._limite_diario_atingido():
            logger.warning("Limite de perda diária atingido — sem novas entradas hoje.")
            publicar_log(
                f"Limite de perda diária atingido (−${self._perda_hoje:.2f}) — bot parado até amanhã",
                level='warn',
            )
            return

        # 5. Verifica número máximo de posições abertas
        posicoes_abertas = self.mt5.posicoes_abertas()
        max_pos          = self.cfg['max_trades_simultaneos']
        if len(posicoes_abertas) >= max_pos:
            logger.debug(f"Máximo de posições atingido ({max_pos}) — aguardando.")
            return

        # Reinicia estado de diagnóstico do ciclo
        self._forming_signal         = False
        self._ultimo_motivo_rejeicao = ''

        # 5. Obtém candles M5 (500 candles ≈ 41h de histórico)
        df = self.mt5.obter_candles('M5', n_candles=500)
        if df is None or len(df) < 50:
            logger.warning("Sem dados suficientes do MT5.")
            return

        # 6. Calcula indicadores
        indice_forca = calcular_indice_forca(df, periodo=14)  # igual ao backtest (default)
        bb           = calcular_bollinger(df, periodo=8, desvios=2.0)
        pivotos      = detectar_pivotos(df, janela=5)
        niveis_sr    = niveis_sr_ativos(df, pivotos, lookback=self.cfg['sr_lookback'])

        # 7. Publica o último candle fechado no Supabase (alimenta o gráfico ao vivo)
        try:
            c_last = df.iloc[-1]
            publicar_candle(
                time_unix  = int(df.index[-1].timestamp()),
                open_price = float(c_last['open']),
                high       = float(c_last['high']),
                low        = float(c_last['low']),
                close      = float(c_last['close']),
                volume     = float(c_last.get('volume', 0)),
                rafi       = float(indice_forca.iloc[-1]) if indice_forca is not None else None,
            )
        except Exception as e:
            logger.debug(f"Erro ao publicar candle: {e}")

        # 8. Verifica sinal de entrada no candle mais recente
        rafi_v = float(indice_forca.iloc[-1]) if indice_forca is not None else 0.0
        self._ultimo_rafi = rafi_v  # mantém gauge atualizado no candle em formação
        sinal  = self._verificar_sinal(df, indice_forca, bb, niveis_sr)
        if sinal is None:
            logger.debug("Sem sinal de entrada.")
            motivo = self._ultimo_motivo_rejeicao or 'Aguardando setup'
            _modo  = self.cfg.get('estrategia_modo', 'rafi')
            _extra = '' if _modo == 'autoscan' else f' | RAFI={rafi_v:.2f}'
            publicar_log(
                f"Ciclo M5 — sem sinal | {motivo}{_extra} | Saldo=${self.capital:.2f}",
                level='info',
            )
            publicar_heartbeat(
                status='waiting', balance=self.capital,
                equity=self.mt5.equity_atual() or self.capital,
                open_positions=len(posicoes_abertas),
                pnl_hoje=self._pnl_hoje, par=self.par,
                server=self._conta_server, account=self._conta_account,
                forming_signal    = self._forming_signal,
                forming_direction = self._forming_direction,
                forming_rafi      = self._forming_rafi if self._forming_signal else rafi_v,
                forming_tf_count  = self._forming_tf_count,
                forming_bb_open   = self._forming_bb_open,
                forming_price     = self._forming_price,
                config_hash=self._config_hash,
                ml_modelo_carregado = _info_ml.get('disponivel', False),
                ml_modo             = _status_ml.get('modo', 'OBSERVAÇÃO'),
                ml_wr_rolling       = _status_ml.get('wr_rolling'),
                ml_pf_rolling       = _status_ml.get('pf_rolling'),
                ml_sinais_hoje      = self._ml_sinais_hoje,
                ml_aprovados_hoje   = self._ml_aprovados_hoje,
                ml_treinado_em      = _info_ml.get('treinado_em') or None,
                ml_threshold        = _info_ml.get('threshold', 0.65),
            )
            return

        # 9. Filtro ML — P(win) ≥ 65% para abrir trade
        candles_lista = self._df_para_candles(df)
        dir_int       = 1 if sinal['direcao'] == 'compra' else -1
        self._ml_sinais_hoje += 1
        deve_operar, prob_ml = filtrar_sinal(
            candles_ate_sinal = candles_lista,
            direcao           = dir_int,
            forca_rompimento  = sinal.get('forca_rompimento', 0.00005),
            rr_ratio          = float(self.cfg['ratio_risco_retorno']),
            wr_rolling20      = self._monitor.wr_rolling(),
        )
        sinal['probabilidade_ml'] = prob_ml
        sinal['ml_aprovado']      = deve_operar
        if deve_operar:
            self._ml_aprovados_hoje += 1

        if not deve_operar:
            logger.info(
                f"Sinal REJEITADO pelo ML | {sinal['direcao'].upper()} | "
                f"P(win)={prob_ml:.1%} < 65%"
            )
            publicar_log(
                f"Sinal {sinal['direcao'].upper()} rejeitado pelo ML | "
                f"P(win)={prob_ml:.1%}",
                level='info',
            )
            return

        # 10. Calcula lote e envia ordem
        publicar_log(
            f"SINAL {sinal['direcao'].upper()} aprovado ML={prob_ml:.1%} | "
            f"Entry={sinal['entry']:.5f} | SL={sinal['stop_loss']:.5f} | "
            f"TP={sinal['take_profit']:.5f} | RAFI={sinal['rafi']:.2f}",
            level='signal',
        )
        self._executar_sinal(sinal, df, indice_forca, bb)

    # ─────────────────────────────────────────────────────────────────────────
    # SINAL DE ENTRADA
    # ─────────────────────────────────────────────────────────────────────────

    def _verificar_sinal(self, df, indice_forca, bb, niveis_sr) -> Optional[dict]:
        """
        Verifica sinal de entrada no último candle.

        Despacha para o modo configurado via dashboard (estrategia_modo):
          'autoscan' → réplica exata do browser (BB squeeze + rompimento S/R, sem RAFI/MA)
          'rafi'     → filtros RAFI completos (MA + RAFI + BB + S/R)

        Retorna dict com {direcao, entry, stop_loss, take_profit, rafi, bb_width}
        ou None se não há sinal.
        """
        modo = self.cfg['estrategia_modo']

        if modo == 'autoscan':
            return self._verificar_sinal_autoscan(df, bb)

        # ── Modo RAFI (padrão) ────────────────────────────────────────────────
        if bb is None or len(bb) < 2:
            return None

        n_needed = max(
            self.cfg['ma_lenta'],
            self.cfg['sr_lookback'],
            self.cfg['swing_stop_lookback'],
        ) + 2
        if len(df) < n_needed:
            return None

        c      = df.iloc[-1]
        rafi_atual = float(indice_forca.iloc[-1]) if indice_forca is not None else 0.0

        # ── Filtro 1: Tendência M5 — MA20 vs MA50 ────────────────────────────
        ma_r   = int(self.cfg['ma_rapida'])
        ma_l   = int(self.cfg['ma_lenta'])
        ma_thr = float(self.cfg['ma_threshold'])
        ma20   = float(df['close'].rolling(ma_r).mean().iloc[-1])
        ma50   = float(df['close'].rolling(ma_l).mean().iloc[-1])
        diff   = ma20 - ma50
        if abs(diff) < ma_thr:
            self._ultimo_motivo_rejeicao = (
                f"Lateral (MA{ma_r}-MA{ma_l}={diff:+.5f} < {ma_thr:.4f})"
            )
            return None
        direcao = 'compra' if diff > 0 else 'venda'

        # ── Filtro 2: RAFI ≥ limiar (padrão 2.50) ────────────────────────────
        forca_limiar = float(self.cfg['forca_limiar'])
        if rafi_atual < forca_limiar:
            # Sinal em formação: RAFI entre 1.75 e limiar → sinaliza no heartbeat
            LIMIAR_FORMANDO = 1.75
            if LIMIAR_FORMANDO <= rafi_atual < forca_limiar:
                sr_lb    = int(self.cfg['sr_lookback'])
                resist2  = float(df['high'].iloc[-(sr_lb+1):-1].max())
                suporte2 = float(df['low'].iloc[-(sr_lb+1):-1].min())
                f_dir    = 'buy' if direcao == 'compra' else 'sell'
                f_price  = resist2 if f_dir == 'buy' else suporte2
                bb_curr_width2 = float(bb['bb_superior'].iloc[-1] - bb['bb_inferior'].iloc[-1])
                bb_prev_width2 = float(bb['bb_superior'].iloc[-2] - bb['bb_inferior'].iloc[-2])
                # Armazena estado no objeto — consolidado no heartbeat do ciclo principal
                self._forming_signal    = True
                self._forming_direction = f_dir
                self._forming_rafi      = rafi_atual
                self._forming_tf_count  = 2
                self._forming_bb_open   = bool(bb_curr_width2 > bb_prev_width2 * 1.05)
                self._forming_price     = f_price
                self._ultimo_motivo_rejeicao = (
                    f"RAFI em formação: {rafi_atual:.2f} (falta {forca_limiar - rafi_atual:.2f})"
                )
                publicar_log(
                    f"Sinal em formação: {f_dir.upper()} | RAFI={rafi_atual:.2f} "
                    f"(falta {forca_limiar - rafi_atual:.2f}) | Nível={f_price:.5f}",
                    level='info',
                )
            else:
                self._ultimo_motivo_rejeicao = (
                    f"RAFI insuficiente: {rafi_atual:.2f} < {forca_limiar:.2f}"
                )
            return None

        # ── Filtro 3: Bollinger squeeze → abrindo (se ativo) ─────────────────
        bb_prev_width = float(bb['bb_superior'].iloc[-2] - bb['bb_inferior'].iloc[-2])
        bb_curr_width = float(bb['bb_superior'].iloc[-1] - bb['bb_inferior'].iloc[-1])
        if self.cfg['bb_filtro_ativo']:
            bb_mid = float(bb['bb_media'].iloc[-1])
            squeeze_ratio = float(self.cfg['bb_limiar_estreita'])
            prev_ratio = bb_prev_width / bb_mid if bb_mid else 0
            curr_ratio = bb_curr_width / bb_mid if bb_mid else 0
            if prev_ratio >= squeeze_ratio:
                self._ultimo_motivo_rejeicao = (
                    f"BB sem squeeze: prev_ratio={prev_ratio:.5f} >= {squeeze_ratio:.4f}"
                )
                return None
            if curr_ratio <= prev_ratio * 1.05:
                self._ultimo_motivo_rejeicao = (
                    f"BB sem expansão: curr={curr_ratio:.5f} <= prev*1.05={prev_ratio*1.05:.5f}"
                )
                return None

        # ── Filtro 4: Cor do candle confirma direção ──────────────────────────
        candle_verde = float(c['close']) >= float(c['open'])
        if direcao == 'compra' and not candle_verde:
            self._ultimo_motivo_rejeicao = "Candle vermelho em modo compra"
            return None
        if direcao == 'venda' and candle_verde:
            self._ultimo_motivo_rejeicao = "Candle verde em modo venda"
            return None

        # ── Filtro 5: Rompimento de S/R (rolling high/low dos últimos N candles) ─
        sr_lb       = int(self.cfg['sr_lookback'])
        close_atual = float(c['close'])
        rolling_high = float(df['high'].iloc[-(sr_lb+1):-1].max())
        rolling_low  = float(df['low'].iloc[-(sr_lb+1):-1].min())

        if direcao == 'compra' and close_atual <= rolling_high:
            self._ultimo_motivo_rejeicao = (
                f"Sem rompimento: close={close_atual:.5f} <= resist={rolling_high:.5f} "
                f"(falta {(rolling_high-close_atual)*10000:.1f}p)"
            )
            return None
        if direcao == 'venda' and close_atual >= rolling_low:
            self._ultimo_motivo_rejeicao = (
                f"Sem rompimento: close={close_atual:.5f} >= suporte={rolling_low:.5f} "
                f"(falta {(close_atual-rolling_low)*10000:.1f}p)"
            )
            return None

        # ── Stop na estrutura: swing_stop dos últimos N candles ───────────────
        sw_lb        = int(self.cfg['swing_stop_lookback'])
        p            = lambda v: round(v, 5)
        ratio_rr     = float(self.cfg['ratio_risco_retorno'])

        if direcao == 'compra':
            nivel_sr = rolling_high
            stop     = p(float(df['low'].iloc[-(sw_lb+1):-1].min()))
            entry    = p(nivel_sr)
            risco    = entry - stop
            if risco <= 0:
                return None
            tp = p(entry + risco * ratio_rr)
            logger.info(
                f"SINAL COMPRA | Entry: {entry:.5f} | SL: {stop:.5f} | TP: {tp:.5f} "
                f"| RAFI: {rafi_atual:.2f} | MA20-MA50: {diff:+.5f}"
            )
            return {
                'direcao': 'compra', 'entry': entry,
                'stop_loss': stop, 'take_profit': tp,
                'rafi': rafi_atual, 'rafi_dir': 'bull', 'bb_width': bb_curr_width,
                'forca_rompimento': max(0.0, close_atual - rolling_high),
            }

        else:
            nivel_sr = rolling_low
            stop     = p(float(df['high'].iloc[-(sw_lb+1):-1].max()))
            entry    = p(nivel_sr)
            risco    = stop - entry
            if risco <= 0:
                return None
            tp = p(entry - risco * ratio_rr)
            logger.info(
                f"SINAL VENDA | Entry: {entry:.5f} | SL: {stop:.5f} | TP: {tp:.5f} "
                f"| RAFI: {rafi_atual:.2f} | MA20-MA50: {diff:+.5f}"
            )
            return {
                'direcao': 'venda', 'entry': entry,
                'stop_loss': stop, 'take_profit': tp,
                'rafi': rafi_atual, 'rafi_dir': 'bear', 'bb_width': bb_curr_width,
                'forca_rompimento': max(0.0, rolling_low - close_atual),
            }

    def _verificar_sinal_autoscan(self, df, bb) -> Optional[dict]:
        """
        Modo Autoscan — réplica exata do browser (indicators.ts autoScanBreakouts).

        Critérios (sem RAFI, sem filtro de MA/tendência, sem filtro de sessão):
          1. BB squeeze no candle anterior (width/mid < squeeze_ratio)
          2. BB expandindo no candle atual (curr_ratio > prev_ratio * expansao_min)
          3. COMPRA: close > max_high(sr_lookback) e close >= open (candle verde)
          4. VENDA:  close < min_low(sr_lookback)  e close <  open (candle vermelho)
          5. Rompimento mínimo: (close - resistance) >= min_breakout
          6. Stop: candle_low - stop_offset (compra) / candle_high + stop_offset (venda)

        Log de diagnóstico: cada filtro rejeitado é registrado em DEBUG para auditoria.
        """
        if bb is None or len(bb) < 2:
            return None

        # sr_lookback é controlado pelo Admin Panel (Supabase) — não usar autoscan_sr_lookback aqui
        sr_lb         = int(self.cfg['sr_lookback'])
        min_breakout  = float(self.cfg['autoscan_min_breakout'])
        stop_offset   = float(self.cfg['autoscan_stop_offset'])
        expansao_min  = float(self.cfg['bb_squeeze_expansao_min'])
        squeeze_ratio = float(self.cfg['bb_limiar_estreita'])
        ratio_rr      = float(self.cfg['ratio_risco_retorno'])
        min_gap       = int(self.cfg['autoscan_min_gap_candles'])

        n_needed = sr_lb + int(self.cfg['bb_periodo']) + 2
        if len(df) < n_needed:
            return None

        ts_label = str(df.index[-1])[:16]

        # Gap mínimo: verifica se passaram candles suficientes desde o último sinal
        candle_ts = int(df.index[-1].timestamp())
        segundos_gap = min_gap * 300  # M5 = 300s por candle
        segundos_decorridos = candle_ts - self._autoscan_ultimo_ts
        if segundos_decorridos < segundos_gap:
            logger.debug(
                f"[{ts_label}] AUTOSCAN REJEITADO — gap insuficiente: "
                f"{segundos_decorridos//60}min < {segundos_gap//60}min mínimo"
            )
            return None

        # BB ratios: width = upper - lower; mid = média
        bb_mid_curr  = float(bb['bb_media'].iloc[-1])
        bb_mid_prev  = float(bb['bb_media'].iloc[-2])
        bb_w_curr    = float(bb['bb_superior'].iloc[-1] - bb['bb_inferior'].iloc[-1])
        bb_w_prev    = float(bb['bb_superior'].iloc[-2] - bb['bb_inferior'].iloc[-2])
        prev_ratio   = bb_w_prev / bb_mid_prev if bb_mid_prev else 0
        curr_ratio   = bb_w_curr / bb_mid_curr if bb_mid_curr else 0

        # Filtro 1: squeeze no candle anterior
        if prev_ratio >= squeeze_ratio:
            logger.debug(
                f"[{ts_label}] AUTOSCAN REJEITADO — BB sem squeeze: "
                f"prev_ratio={prev_ratio:.5f} >= limite={squeeze_ratio:.4f} "
                f"(BB largura={bb_w_prev*10000:.1f} pips)"
            )
            self._ultimo_motivo_rejeicao = (
                f"BB não estreita: ratio={prev_ratio:.5f} (precisa < {squeeze_ratio:.4f}) "
                f"| largura={bb_w_prev*10000:.1f}p"
            )
            return None

        # Filtro 2: expansão no candle atual
        if curr_ratio <= prev_ratio * expansao_min:
            logger.debug(
                f"[{ts_label}] AUTOSCAN REJEITADO — BB sem expansão: "
                f"curr={curr_ratio:.5f} <= prev*{expansao_min}={prev_ratio*expansao_min:.5f}"
            )
            self._ultimo_motivo_rejeicao = (
                f"BB sem expansão: curr={curr_ratio:.5f} <= prev*{expansao_min:.2f}={prev_ratio*expansao_min:.5f}"
            )
            return None

        c      = df.iloc[-1]
        close  = float(c['close'])
        open_  = float(c['open'])
        low    = float(c['low'])
        high   = float(c['high'])

        # S/R = max HIGH / min LOW dos candles anteriores (sem lookahead)
        window     = df.iloc[-(sr_lb + 1):-1]
        resistance = float(window['high'].max())
        support    = float(window['low'].min())

        p = lambda v: round(v, 5)

        # COMPRA: fecha acima da resistência, candle verde
        if close > resistance and (close - resistance) >= min_breakout and close >= open_:
            entry = p(resistance)
            stop  = p(low - stop_offset)
            risco = entry - stop
            if risco <= 0:
                return None
            tp = p(entry + risco * ratio_rr)
            logger.info(
                f"SINAL AUTOSCAN COMPRA | Entry: {entry:.5f} | SL: {stop:.5f} | TP: {tp:.5f} "
                f"| BB_ratio: prev={prev_ratio:.5f} curr={curr_ratio:.5f} "
                f"| romp={((close-resistance)*10000):.1f}p | SR_lb={sr_lb}c"
            )
            self._autoscan_ultimo_ts = candle_ts
            return {
                'direcao': 'compra', 'entry': entry,
                'stop_loss': stop, 'take_profit': tp,
                'rafi': 0.0, 'rafi_dir': 'bull', 'bb_width': bb_w_curr,
                'forca_rompimento': close - resistance,
            }

        # VENDA: fecha abaixo do suporte, candle vermelho
        if close < support and (support - close) >= min_breakout and close < open_:
            entry = p(support)
            stop  = p(high + stop_offset)
            risco = stop - entry
            if risco <= 0:
                return None
            tp = p(entry - risco * ratio_rr)
            logger.info(
                f"SINAL AUTOSCAN VENDA | Entry: {entry:.5f} | SL: {stop:.5f} | TP: {tp:.5f} "
                f"| BB_ratio: prev={prev_ratio:.5f} curr={curr_ratio:.5f} "
                f"| romp={((support-close)*10000):.1f}p | SR_lb={sr_lb}c"
            )
            self._autoscan_ultimo_ts = candle_ts
            return {
                'direcao': 'venda', 'entry': entry,
                'stop_loss': stop, 'take_profit': tp,
                'rafi': 0.0, 'rafi_dir': 'bear', 'bb_width': bb_w_curr,
                'forca_rompimento': support - close,
            }

        # Passou BB squeeze + expansão mas não rompeu S/R — sinal em formação
        dist_resist = close - resistance
        dist_suport = support - close
        f_dir       = 'buy' if dist_resist > dist_suport else 'sell'
        f_price     = resistance if f_dir == 'buy' else support
        self._forming_signal    = True
        self._forming_direction = f_dir
        self._forming_rafi      = 0.0   # autoscan não usa RAFI
        self._forming_bb_open   = True
        self._forming_price     = f_price
        self._ultimo_motivo_rejeicao = (
            f"BB OK mas sem rompimento S/R | "
            f"falta {max(dist_resist, dist_suport)*10000:.1f}p | "
            f"min={min_breakout*10000:.1f}p"
        )
        logger.debug(
            f"[{ts_label}] AUTOSCAN BB OK mas sem rompimento S/R | "
            f"close={close:.5f} | resist={resistance:.5f} (+{dist_resist*10000:.1f}p) | "
            f"suport={support:.5f} ({dist_suport*10000:.1f}p) | "
            f"min_break={min_breakout*10000:.1f}p | candle={'verde' if close>=open_ else 'vermelho'}"
        )
        return None

    # ─────────────────────────────────────────────────────────────────────────
    # HELPERS
    # ─────────────────────────────────────────────────────────────────────────

    @staticmethod
    def _df_para_candles(df) -> list:
        """Converte DataFrame de candles para lista de dicts usada pelo feature_builder."""
        candles = []
        for ts, row in df.iterrows():
            candles.append({
                'time':  int(ts.timestamp()),
                'open':  float(row['open']),
                'high':  float(row['high']),
                'low':   float(row['low']),
                'close': float(row['close']),
            })
        return candles

    # ─────────────────────────────────────────────────────────────────────────
    # EXECUÇÃO DA ORDEM
    # ─────────────────────────────────────────────────────────────────────────

    def _executar_sinal(self, sinal: dict, df, indice_forca, bb) -> None:
        """Calcula lote, envia ordem ao MT5 e sincroniza com Supabase."""
        # Lote pela tabela de escalonamento (mesma lógica do dashboard)
        lote = lote_por_faixa(self.capital)

        resultado = self.mt5.enviar_ordem(
            sinal=sinal['direcao'],
            lote=lote,
            stop_loss=sinal['stop_loss'],
            take_profit=sinal['take_profit'],
            comentario=f"RAFI {sinal['direcao'].upper()} RAFI={sinal['rafi']:.1f}",
        )

        if resultado is None:
            logger.error("Ordem não executada.")
            return

        ticket    = resultado['ticket']
        preco_ent = resultado['preco_entrada']
        ts        = int(time.time())

        # Registra posição aberta para monitoramento (inclui dados ML para gravação ao fechar)
        self._posicoes[ticket] = {
            'ts':              ts,
            'entry':           preco_ent,
            'stop_loss':       sinal['stop_loss'],
            'take_profit':     sinal['take_profit'],
            'lot':             lote,
            'direcao':         sinal['direcao'],
            'rafi':            sinal['rafi'],
            'rafi_dir':        sinal['rafi_dir'],
            'bb_width':        sinal['bb_width'],
            'probabilidade_ml': sinal.get('probabilidade_ml'),
            'ml_aprovado':     sinal.get('ml_aprovado'),
            'forca_rompimento': sinal.get('forca_rompimento', 0.0),
            'rr_ratio':        float(self.cfg['ratio_risco_retorno']),
        }

        # ── Sincroniza com Supabase (aparece no admin) ────────────────────────
        sincronizar_trade(
            ticket      = ticket,
            direction   = sinal['direcao'],
            entry       = preco_ent,
            stop_loss   = sinal['stop_loss'],
            take_profit = sinal['take_profit'],
            lot         = lote,
            rafi        = sinal['rafi'],
            rafi_dir    = sinal['rafi_dir'],
            bb_width    = sinal['bb_width'],
            result      = 'pending',
            ts          = ts,
        )

    # ─────────────────────────────────────────────────────────────────────────
    # MONITORAMENTO DE POSIÇÕES
    # ─────────────────────────────────────────────────────────────────────────

    def _restaurar_posicoes_abertas(self) -> None:
        """
        Reconstrói self._posicoes com as posições que o MT5 já tem abertas.

        Chamado no startup, após conectar ao MT5. Garante que posições abertas
        antes de um reinício do bot continuem sendo monitoradas — sem isso,
        quando o SL/TP bater, o bot não detecta o fechamento e o trade fica
        preso como 'pending' no Supabase para sempre.

        Não envia nenhuma ordem nem altera parâmetros de risco.
        """
        posicoes_mt5 = self.mt5.posicoes_abertas()
        if not posicoes_mt5:
            return

        restauradas = 0
        for p in posicoes_mt5:
            ticket = p['ticket']
            if ticket in self._posicoes:
                continue  # já rastreada (não deveria acontecer no startup)

            self._posicoes[ticket] = {
                'ts':          int(time.time()),
                'entry':       p['preco_entrada'],
                'stop_loss':   p['stop_loss'],
                'take_profit': p['take_profit'],
                'lot':         p['lote'],
                'direcao':     p['sinal'],
                # sem rafi/bb_width — desconhecidos após reinício
            }
            restauradas += 1
            logger.info(
                f"[Restore] Posição #{ticket} restaurada do MT5 — "
                f"{p['sinal'].upper()} @ {p['preco_entrada']:.5f}"
            )

        if restauradas:
            publicar_log(
                f"{restauradas} posição(ões) restaurada(s) do MT5 após reinício",
                level='warn',
            )

    def _monitorar_posicoes(self) -> None:
        """
        Verifica posições abertas. Para cada ticket que o MT5 fechou
        (SL ou TP atingido), atualiza o resultado no Supabase.
        """
        if not self._posicoes:
            return

        tickets_abertos = {p['ticket'] for p in self.mt5.posicoes_abertas()}

        for ticket, info in list(self._posicoes.items()):
            if ticket in tickets_abertos:
                continue  # ainda aberta — aguarda

            # Posição foi fechada — usa histórico de deals (evita race-condition no saldo)
            cap_novo  = self.mt5.capital_atual()
            pnl_info  = self.mt5.pnl_real_posicao(ticket)
            if pnl_info is not None:
                pnl_trade = pnl_info['liquido']   # bruto + commission + swap do MT5
            else:
                pnl_trade = (cap_novo - self.capital) if cap_novo is not None else 0.0
            resultado = 'win' if pnl_trade > 0 else 'loss'

            logger.info(
                f"Posição #{ticket} fechada → {resultado.upper()} "
                f"| P&L: ${pnl_trade:+.2f} | Saldo: ${cap_novo:.2f}"
            )
            publicar_log(
                f"Posição #{ticket} fechada → {resultado.upper()} | P&L: ${pnl_trade:+.2f} | Saldo: ${cap_novo:.2f}",
                level='signal' if resultado == 'win' else 'warn',
            )

            # Acumula P&L do dia e controle de perda diária
            self._pnl_hoje += pnl_trade
            if resultado == 'loss':
                self._perda_hoje += abs(pnl_trade)

            # Atualiza saldo e Supabase (tabela rafi_bot_status)
            if cap_novo is not None:
                self.capital = cap_novo
            atualizar_resultado(ticket=ticket, result=resultado,
                                ts=info['ts'], pnl=pnl_trade)

            # Resultado em múltiplos de R para o monitor ML
            rr      = info.get('rr_ratio', 1.3)
            lucro_r = rr if resultado == 'win' else -1.0
            resultado_int = 1 if resultado == 'win' else 0

            # Grava na tabela rafi_trades (alimenta o modelo ML)
            gravar_rafi_trade(
                resultado        = resultado_int,
                lucro_r          = lucro_r,
                lucro_usd        = pnl_trade,
                lotes            = info.get('lot'),
                direcao          = 1 if info['direcao'] == 'compra' else -1,
                forca_rompimento = info.get('forca_rompimento'),
                rr_ratio         = rr,
                preco_entrada    = info.get('entry'),
                preco_saida      = cap_novo,       # aproximação — MT5 fecha ao preço de mercado
                preco_stop       = info.get('stop_loss'),
                preco_target     = info.get('take_profit'),
                probabilidade_ml = info.get('probabilidade_ml'),
                ml_aprovado      = info.get('ml_aprovado'),
            )

            # Registra no monitor de performance (dispara retreino se WR/PF cair)
            self._monitor.registrar_trade(
                resultado = resultado_int,
                lucro_r   = lucro_r,
            )

            del self._posicoes[ticket]

    # ─────────────────────────────────────────────────────────────────────────
    # COMANDOS DO DASHBOARD
    # ─────────────────────────────────────────────────────────────────────────

    def _processar_comando_avancado(self, cmd: dict) -> None:
        """Processa comandos avançados recebidos do dashboard (fechar, ordem manual, start/restart)."""
        comando = cmd.get('command')

        if comando == 'start':
            logger.info("Comando START recebido — bot já está em execução.")
            return

        elif comando == 'restart':
            logger.info("Comando RESTART recebido — bot irá reinicializar.")
            self._deve_reiniciar = True
            return

        elif comando == 'close_position':
            logger.info("Comando FECHAR POSIÇÃO recebido do dashboard")
            for pos in self.mt5.posicoes_abertas():
                ticket = pos['ticket']
                if self.mt5.fechar_posicao(ticket):
                    logger.info(f"Posição #{ticket} fechada pelo dashboard")

        elif comando in ('buy_manual', 'sell_manual'):
            direcao = 'compra' if comando == 'buy_manual' else 'venda'
            logger.info(f"Ordem manual {direcao.upper()} recebida do dashboard")

            # Verifica limite de posições
            if len(self.mt5.posicoes_abertas()) >= self.cfg['max_trades_simultaneos']:
                logger.warning("Máximo de posições atingido — ordem manual ignorada.")
                return

            df = self.mt5.obter_candles('M5', n_candles=30)
            if df is None:
                return

            c = df.iloc[-1]
            lote = lote_por_faixa(self.capital)
            p = lambda v: round(v, 5)
            rr = self.cfg['ratio_risco_retorno']

            if direcao == 'compra':
                stop  = p(float(c['low']) - 0.00015)
                entry = p(float(c['high']))
                risco = entry - stop
                if risco <= 0:
                    return
                sinal_dict = {
                    'direcao': 'compra', 'entry': entry,
                    'stop_loss': stop, 'take_profit': p(entry + risco * rr),
                    'rafi': 0.0, 'rafi_dir': 'bull', 'bb_width': 0.0,
                }
            else:
                stop  = p(float(c['high']) + 0.00015)
                entry = p(float(c['low']))
                risco = stop - entry
                if risco <= 0:
                    return
                sinal_dict = {
                    'direcao': 'venda', 'entry': entry,
                    'stop_loss': stop, 'take_profit': p(entry - risco * rr),
                    'rafi': 0.0, 'rafi_dir': 'bear', 'bb_width': 0.0,
                }

            indice_forca = calcular_indice_forca(df, periodo=14)  # igual ao backtest (default)
            bb = calcular_bollinger(df, periodo=8, desvios=2.0)
            self._executar_sinal(sinal_dict, df, indice_forca, bb)

    def _publicar_historico_inicial(self, df) -> None:
        """Publica os últimos candles no Supabase para preencher o gráfico na inicialização."""
        try:
            candles = []
            for ts, row in df.tail(200).iterrows():
                candles.append({
                    'time':   int(ts.timestamp()),
                    'open':   round(float(row['open']),  5),
                    'high':   round(float(row['high']),  5),
                    'low':    round(float(row['low']),   5),
                    'close':  round(float(row['close']), 5),
                    'volume': round(float(row.get('volume', 0)), 2),
                    'rafi':   None,
                })
            publicar_candles_batch(candles)
        except Exception as e:
            logger.debug(f"Erro ao publicar histórico inicial: {e}")

    # ─────────────────────────────────────────────────────────────────────────
    # PROTEÇÕES
    # ─────────────────────────────────────────────────────────────────────────

    def _verificar_reset_diario(self) -> None:
        """Zera os contadores de perda e P&L à meia-noite UTC."""
        hoje = datetime.utcnow().date()
        if hoje != self._data_hoje:
            logger.info(
                f"Novo dia UTC — reiniciando contadores "
                f"(perda: ${self._perda_hoje:.2f} | P&L: ${self._pnl_hoje:+.2f})"
            )
            self._perda_hoje        = 0.0
            self._pnl_hoje          = 0.0
            self._data_hoje         = hoje
            self._ml_sinais_hoje    = 0
            self._ml_aprovados_hoje = 0

    def _limite_diario_atingido(self) -> bool:
        """
        Verifica se a perda diária atingiu o limite configurado (5% padrão).

        Retorna True se o bot deve parar de operar hoje.
        Com saldo zero ou negativo, não bloqueia (aguarda depósito).
        """
        if self.capital <= 0:
            return False   # conta vazia — aguarda depósito, não bloqueia
        limite_pct = self.cfg['risco_maximo_diario']
        limite_usd = self.capital * (limite_pct / 100)
        return self._perda_hoje >= limite_usd


# ── Ponto de entrada ──────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description='Bot RAFI — EURUSD M5')
    parser.add_argument('--config', default='config.yaml', help='Arquivo de configuração YAML')
    parser.add_argument('--broker', default=None,
                        help='ID da corretora a usar: xm | pepperstone (padrão: primeira ativa no Supabase)')
    args = parser.parse_args()

    # Carrega variáveis de ambiente do .env — busca na pasta atual e na raiz do repo
    # utf-8-sig remove o BOM que o PowerShell adiciona automaticamente
    for env_path in [Path('.env'), Path(__file__).parent.parent / '.env']:
        if env_path.exists():
            for linha in env_path.read_text(encoding='utf-8-sig').splitlines():
                linha = linha.strip()
                if '=' in linha and not linha.startswith('#'):
                    chave, valor = linha.split('=', 1)
                    os.environ[chave.strip()] = valor.strip()  # força sobrescrever
            logger.info(f".env carregado de: {env_path.resolve()}")
            break

    cfg = carregar_config(args.config)
    if args.broker:
        cfg['_broker_arg'] = args.broker.lower()
    bot = RafiBot(cfg)
    bot.rodar()


if __name__ == '__main__':
    main()
