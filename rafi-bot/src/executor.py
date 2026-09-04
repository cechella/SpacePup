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
import sys
import time
import logging
import argparse
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
from .risk_manager import lote_por_faixa
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
    publicar_status_broker,
)

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
    # Serializa apenas as chaves que afetam as regras da estratégia
    CHAVES = [
        'par', 'forca_limiar', 'rafi_periodo', 'sr_lookback', 'swing_stop_lookback',
        'ma_rapida', 'ma_lenta', 'ma_threshold', 'bb_filtro_ativo', 'bb_limiar_estreita',
        'bb_periodo', 'bb_desvios', 'risco_por_trade', 'ratio_risco_retorno',
        'max_trades_simultaneos', 'risco_maximo_diario', 'capital_inicial',
    ]
    snapshot = {k: cfg.get(k) for k in CHAVES}
    serializado = json.dumps(snapshot, sort_keys=True, ensure_ascii=False)
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

        # Rastreia trades abertos: {ticket: {ts, entry, sl, tp, lot}}
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

        # Broker ativo: lê do Supabase qual corretora está habilitada
        # --broker xm | --broker pepperstone seleciona qual usar quando múltiplas estão ativas
        broker_id_arg = config.get('_broker_arg')  # injetado por main() via --broker
        broker_supa   = carregar_broker_ativo(broker_id=broker_id_arg)
        if broker_supa:
            bid    = broker_supa['id']
            creds  = config.get('corretoras', {}).get(bid, {})
            self._broker_id       = bid
            self._broker_login    = creds.get('login')
            self._broker_senha    = creds.get('senha')
            self._broker_servidor = broker_supa.get('servidor') or creds.get('servidor')
            # Símbolo correto por corretora (EURUSD# vs EURUSD)
            self.par            = broker_supa.get('simbolo') or creds.get('simbolo') or self.par
            self.cfg['par']     = self.par
            self.mt5.par        = self.par
            logger.info(f"Broker ativo (Supabase): {bid} | Símbolo: {self.par}")
        else:
            # Fallback: usa o par do config.yaml sem autenticação separada
            self._broker_id       = config.get('corretora', 'xm').lower()
            self._broker_login    = None
            self._broker_senha    = None
            self._broker_servidor = None
            logger.warning("rafi_brokers indisponível — usando par do config.yaml (fallback)")

        # Hash do config efetivo (pós-overrides) — exibido no dashboard para rastreabilidade
        self._config_hash = calcular_hash_config(self.cfg)
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
            login    = self._broker_login,
            senha    = self._broker_senha,
            servidor = self._broker_servidor,
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

                # Comandos avançados do dashboard (fechar posição, ordem manual)
                cmd = verificar_comando_avancado()
                if cmd:
                    self._processar_comando_avancado(cmd)

                # Reset diário
                self._verificar_reset_diario()

                # Ciclo principal
                self._ciclo()

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
                        )
                        # Candle em formação: atualiza o gráfico entre fechamentos M5
                        candle_formando = self.mt5.obter_candle_formando()
                        if candle_formando:
                            publicar_candle(
                                time_unix  = candle_formando['time'],
                                open_price = candle_formando['open'],
                                high       = candle_formando['high'],
                                low        = candle_formando['low'],
                                close      = candle_formando['close'],
                                volume     = candle_formando['volume'],
                            )

        except KeyboardInterrupt:
            logger.info("Ctrl+C — encerrando bot.")
        finally:
            self.mt5.desconectar()
            logger.info("Bot encerrado.")

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
        )
        # Atualiza card da corretora no /admin/brokers
        publicar_status_broker(
            broker_id   = self._broker_id,
            saldo       = self.capital,
            posicoes    = len(posicoes_abertas_hb),
            pnl_hoje    = self._pnl_hoje,
            status_text = ('OPERANDO' if posicoes_abertas_hb
                           else 'PARADO' if self._limite_diario_atingido()
                           else 'AGUARDANDO SINAL'),
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
        max_pos          = self.cfg.get('max_trades_simultaneos', 1)
        if len(posicoes_abertas) >= max_pos:
            logger.debug(f"Máximo de posições atingido ({max_pos}) — aguardando.")
            return

        # 5. Obtém candles M5 (500 candles ≈ 41h de histórico)
        df = self.mt5.obter_candles('M5', n_candles=500)
        if df is None or len(df) < 50:
            logger.warning("Sem dados suficientes do MT5.")
            return

        # 6. Calcula indicadores
        indice_forca = calcular_indice_forca(df, periodo=14)  # igual ao backtest (default)
        bb           = calcular_bollinger(df, periodo=8, desvios=2.0)
        pivotos      = detectar_pivotos(df, janela=5)
        niveis_sr    = niveis_sr_ativos(df, pivotos, lookback=self.cfg.get('sr_lookback', 20))

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
        sinal  = self._verificar_sinal(df, indice_forca, bb, niveis_sr)
        if sinal is None:
            logger.debug("Sem sinal de entrada.")
            publicar_log(
                f"Ciclo M5 — sem sinal | RAFI={rafi_v:.2f} | "
                f"Saldo=${self.capital:.2f} | Pos={len(posicoes_abertas)}",
                level='info',
            )
            # Atualiza gauge do dashboard com RAFI atual (mesmo sem sinal)
            publicar_heartbeat(
                status='waiting', balance=self.capital,
                equity=self.mt5.equity_atual() or self.capital,
                open_positions=len(posicoes_abertas),
                pnl_hoje=self._pnl_hoje, par=self.par,
                server=self._conta_server, account=self._conta_account,
                forming_signal=False, forming_rafi=rafi_v,
                config_hash=self._config_hash,
            )
            return

        # 9. Calcula lote e envia ordem
        publicar_log(
            f"SINAL {sinal['direcao'].upper()} detectado | Entry={sinal['entry']:.5f} | "
            f"SL={sinal['stop_loss']:.5f} | TP={sinal['take_profit']:.5f} | RAFI={sinal['rafi']:.2f}",
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
        modo = self.cfg.get('estrategia_modo', 'rafi')

        if modo == 'autoscan':
            return self._verificar_sinal_autoscan(df, bb)

        # ── Modo RAFI (padrão) ────────────────────────────────────────────────
        if bb is None or len(bb) < 2:
            return None

        n_needed = max(
            self.cfg.get('ma_lenta', 50),
            self.cfg.get('sr_lookback', 50),
            self.cfg.get('swing_stop_lookback', 150),
        ) + 2
        if len(df) < n_needed:
            return None

        c      = df.iloc[-1]
        rafi_atual = float(indice_forca.iloc[-1]) if indice_forca is not None else 0.0

        # ── Filtro 1: Tendência M5 — MA20 vs MA50 ────────────────────────────
        ma_r   = int(self.cfg.get('ma_rapida', 20))
        ma_l   = int(self.cfg.get('ma_lenta', 50))
        ma_thr = float(self.cfg.get('ma_threshold', 0.0003))
        ma20   = float(df['close'].rolling(ma_r).mean().iloc[-1])
        ma50   = float(df['close'].rolling(ma_l).mean().iloc[-1])
        diff   = ma20 - ma50
        if abs(diff) < ma_thr:
            return None   # mercado lateral
        direcao = 'compra' if diff > 0 else 'venda'

        # ── Filtro 2: RAFI ≥ limiar (padrão 2.50) ────────────────────────────
        forca_limiar = float(self.cfg.get('forca_limiar', 2.50))
        if rafi_atual < forca_limiar:
            # Sinal em formação: RAFI entre 1.75 e limiar
            LIMIAR_FORMANDO = 1.75
            if LIMIAR_FORMANDO <= rafi_atual < forca_limiar:
                sr_lb    = int(self.cfg.get('sr_lookback', 50))
                resist2  = float(df['high'].iloc[-(sr_lb+1):-1].max())
                suporte2 = float(df['low'].iloc[-(sr_lb+1):-1].min())
                f_dir    = 'buy' if direcao == 'compra' else 'sell'
                f_price  = resist2 if f_dir == 'buy' else suporte2
                bb_curr_width2 = float(bb['bb_superior'].iloc[-1] - bb['bb_inferior'].iloc[-1])
                bb_prev_width2 = float(bb['bb_superior'].iloc[-2] - bb['bb_inferior'].iloc[-2])
                publicar_heartbeat(
                    status='waiting', balance=self.capital,
                    equity=self.mt5.equity_atual() or self.capital,
                    open_positions=len(self.mt5.posicoes_abertas()),
                    pnl_hoje=self._pnl_hoje, par=self.par,
                    server=self._conta_server, account=self._conta_account,
                    forming_signal=True, forming_direction=f_dir,
                    forming_rafi=rafi_atual, forming_tf_count=2,
                    forming_bb_open=bool(bb_curr_width2 > bb_prev_width2 * 1.05),
                    forming_price=f_price,
                    config_hash=self._config_hash,
                )
                publicar_log(
                    f"Sinal em formação: {f_dir.upper()} | RAFI={rafi_atual:.2f} "
                    f"(falta {forca_limiar - rafi_atual:.2f}) | Nível={f_price:.5f}",
                    level='info',
                )
            return None

        # ── Filtro 3: Bollinger squeeze → abrindo (se ativo) ─────────────────
        bb_prev_width = float(bb['bb_superior'].iloc[-2] - bb['bb_inferior'].iloc[-2])
        bb_curr_width = float(bb['bb_superior'].iloc[-1] - bb['bb_inferior'].iloc[-1])
        if self.cfg.get('bb_filtro_ativo', True):
            bb_mid = float(bb['bb_media'].iloc[-1])
            squeeze_ratio = float(self.cfg.get('bb_limiar_estreita', 0.0012))
            prev_ratio = bb_prev_width / bb_mid if bb_mid else 0
            curr_ratio = bb_curr_width / bb_mid if bb_mid else 0
            if prev_ratio >= squeeze_ratio:
                return None
            if curr_ratio <= prev_ratio * 1.05:
                return None

        # ── Filtro 4: Cor do candle confirma direção ──────────────────────────
        candle_verde = float(c['close']) >= float(c['open'])
        if direcao == 'compra' and not candle_verde:
            return None
        if direcao == 'venda' and candle_verde:
            return None

        # ── Filtro 5: Rompimento de S/R (rolling high/low dos últimos N candles) ─
        sr_lb       = int(self.cfg.get('sr_lookback', 50))
        close_atual = float(c['close'])
        rolling_high = float(df['high'].iloc[-(sr_lb+1):-1].max())
        rolling_low  = float(df['low'].iloc[-(sr_lb+1):-1].min())

        if direcao == 'compra' and close_atual <= rolling_high:
            return None
        if direcao == 'venda' and close_atual >= rolling_low:
            return None

        # ── Stop na estrutura: swing_stop dos últimos N candles ───────────────
        sw_lb        = int(self.cfg.get('swing_stop_lookback', 150))
        p            = lambda v: round(v, 5)
        ratio_rr     = float(self.cfg.get('ratio_risco_retorno', 1.5))

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
        """
        if bb is None or len(bb) < 2:
            return None

        sr_lb         = int(self.cfg.get('sr_lookback', 20))
        min_breakout  = float(self.cfg.get('autoscan_min_breakout', 0.00003))
        stop_offset   = float(self.cfg.get('autoscan_stop_offset', 0.00015))
        expansao_min  = float(self.cfg.get('bb_squeeze_expansao_min', 1.05))
        squeeze_ratio = float(self.cfg.get('bb_limiar_estreita', 0.0012))
        ratio_rr      = float(self.cfg.get('ratio_risco_retorno', 1.5))
        min_gap       = int(self.cfg.get('autoscan_min_gap_candles', 8))

        n_needed = sr_lb + int(self.cfg.get('bb_periodo', 8)) + 2
        if len(df) < n_needed:
            return None

        # Gap mínimo: verifica se passaram candles suficientes desde o último sinal
        candle_ts = int(df.index[-1].timestamp())
        segundos_gap = min_gap * 300  # M5 = 300s por candle
        if candle_ts - self._autoscan_ultimo_ts < segundos_gap:
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
            return None
        # Filtro 2: expansão no candle atual
        if curr_ratio <= prev_ratio * expansao_min:
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
                f"| BB_ratio: prev={prev_ratio:.5f} curr={curr_ratio:.5f}"
            )
            self._autoscan_ultimo_ts = candle_ts
            return {
                'direcao': 'compra', 'entry': entry,
                'stop_loss': stop, 'take_profit': tp,
                'rafi': 0.0, 'rafi_dir': 'bull', 'bb_width': bb_w_curr,
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
                f"| BB_ratio: prev={prev_ratio:.5f} curr={curr_ratio:.5f}"
            )
            self._autoscan_ultimo_ts = candle_ts
            return {
                'direcao': 'venda', 'entry': entry,
                'stop_loss': stop, 'take_profit': tp,
                'rafi': 0.0, 'rafi_dir': 'bear', 'bb_width': bb_w_curr,
            }

        return None

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

        # Registra posição aberta para monitoramento
        self._posicoes[ticket] = {
            'ts':          ts,
            'entry':       preco_ent,
            'stop_loss':   sinal['stop_loss'],
            'take_profit': sinal['take_profit'],
            'lot':         lote,
            'direcao':     sinal['direcao'],
            'rafi':        sinal['rafi'],
            'rafi_dir':    sinal['rafi_dir'],
            'bb_width':    sinal['bb_width'],
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

            # Posição foi fechada — calcula P&L real pelo saldo
            cap_novo  = self.mt5.capital_atual()
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

            # Atualiza saldo e Supabase
            if cap_novo is not None:
                self.capital = cap_novo
            atualizar_resultado(ticket=ticket, result=resultado,
                                ts=info['ts'], pnl=pnl_trade)

            del self._posicoes[ticket]

    # ─────────────────────────────────────────────────────────────────────────
    # COMANDOS DO DASHBOARD
    # ─────────────────────────────────────────────────────────────────────────

    def _processar_comando_avancado(self, cmd: dict) -> None:
        """Processa comandos avançados recebidos do dashboard (fechar, ordem manual)."""
        comando = cmd.get('command')

        if comando == 'close_position':
            logger.info("Comando FECHAR POSIÇÃO recebido do dashboard")
            for pos in self.mt5.posicoes_abertas():
                ticket = pos['ticket']
                if self.mt5.fechar_posicao(ticket):
                    logger.info(f"Posição #{ticket} fechada pelo dashboard")

        elif comando in ('buy_manual', 'sell_manual'):
            direcao = 'compra' if comando == 'buy_manual' else 'venda'
            logger.info(f"Ordem manual {direcao.upper()} recebida do dashboard")

            # Verifica limite de posições
            if len(self.mt5.posicoes_abertas()) >= self.cfg.get('max_trades_simultaneos', 1):
                logger.warning("Máximo de posições atingido — ordem manual ignorada.")
                return

            df = self.mt5.obter_candles('M5', n_candles=30)
            if df is None:
                return

            c = df.iloc[-1]
            lote = lote_por_faixa(self.capital)
            p = lambda v: round(v, 5)
            rr = self.cfg.get('ratio_risco_retorno', 1.5)

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
            self._perda_hoje = 0.0
            self._pnl_hoje   = 0.0
            self._data_hoje  = hoje

    def _limite_diario_atingido(self) -> bool:
        """
        Verifica se a perda diária atingiu o limite configurado (5% padrão).

        Retorna True se o bot deve parar de operar hoje.
        Com saldo zero ou negativo, não bloqueia (aguarda depósito).
        """
        if self.capital <= 0:
            return False   # conta vazia — aguarda depósito, não bloqueia
        limite_pct = self.cfg.get('risco_maximo_diario', 5.0)
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
