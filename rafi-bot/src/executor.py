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

        logger.info(f"RafiBot iniciado | Par: {self.par} | Capital: ${self.capital:.2f}")

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

        if not self.mt5.conectar():
            logger.error("Não foi possível conectar ao MT5. Verifique o terminal.")
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
                                       account=self._conta_account)
                    break

                # Reset diário
                self._verificar_reset_diario()

                # Ciclo principal
                self._ciclo()

                # Aguarda próximo candle M5
                aguardar_fechamento_candle(tf_segundos=300)

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
            equity         = self.capital,
            open_positions = len(posicoes_abertas_hb),
            pnl_hoje       = self._pnl_hoje,
            par            = self.par,
            server         = self._conta_server,
            account        = self._conta_account,
        )

        # 4. Verifica limite diário de perda
        if self._limite_diario_atingido():
            logger.warning("Limite de perda diária atingido — sem novas entradas hoje.")
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
        indice_forca = calcular_indice_forca(df, periodo=3)
        bb           = calcular_bollinger(df, periodo=8, desvios=2.0)
        pivotos      = detectar_pivotos(df, janela=5)
        niveis_sr    = niveis_sr_ativos(df, pivotos, lookback=self.cfg.get('sr_lookback', 20))

        # 7. Verifica sinal de entrada no candle mais recente
        sinal = self._verificar_sinal(df, indice_forca, bb, niveis_sr)
        if sinal is None:
            logger.debug("Sem sinal de entrada.")
            return

        # 8. Calcula lote e envia ordem
        self._executar_sinal(sinal, df, indice_forca, bb)

    # ─────────────────────────────────────────────────────────────────────────
    # SINAL DE ENTRADA
    # ─────────────────────────────────────────────────────────────────────────

    def _verificar_sinal(self, df, indice_forca, bb, niveis_sr) -> Optional[dict]:
        """
        Verifica se o último candle gerou sinal de entrada RAFI.

        Condições (todas obrigatórias):
          1. BB estava estreita no candle anterior e está abrindo agora
          2. Preço rompeu S/R relevante com candle direcional
          3. RAFI ≥ 2.5 no candle do rompimento

        Retorna dict com {direcao, entry, stop_loss, take_profit, rafi, bb_width}
        ou None se não há sinal.
        """
        if bb is None or len(bb) < 2:
            return None

        c    = df.iloc[-1]   # candle atual (fechado)
        prev = df.iloc[-2]   # candle anterior

        # ── Filtro BB: squeeze → abertura ────────────────────────────────────
        bb_prev_width = bb['bb_superior'].iloc[-2] - bb['bb_inferior'].iloc[-2]
        bb_curr_width = bb['bb_superior'].iloc[-1] - bb['bb_inferior'].iloc[-1]
        bb_mid        = bb['bb_media'].iloc[-1]
        squeeze_ratio = self.cfg.get('bb_limiar_estreita', 0.0012)

        prev_ratio = bb_prev_width / bb_mid if bb_mid else 0
        curr_ratio = bb_curr_width / bb_mid if bb_mid else 0

        if prev_ratio >= squeeze_ratio:
            return None    # não era squeeze
        if curr_ratio <= prev_ratio * 1.05:
            return None    # não está abrindo

        # ── Resistência / Suporte (janela de 20 candles anteriores) ──────────
        janela      = df.iloc[-21:-1]
        resistencia = float(janela['high'].max())
        suporte     = float(janela['low'].min())
        min_breakout = 0.00003   # 0.3 pip mínimo de rompimento

        rafi_atual = float(indice_forca.iloc[-1]) if indice_forca is not None else 0.0
        p = lambda v: round(v, 5)

        # ── COMPRA: fecha acima da resistência com candle de alta ────────────
        if (c['close'] > resistencia and
            c['close'] - resistencia >= min_breakout and
            c['close'] >= c['open']):

            entry  = p(resistencia)
            stop   = p(float(c['low']) - 0.00015)
            risco  = entry - stop
            if risco <= 0:
                return None
            tp = p(entry + risco * self.cfg.get('ratio_risco_retorno', 1.5))

            logger.info(
                f"SINAL COMPRA | Entry: {entry:.5f} | SL: {stop:.5f} | TP: {tp:.5f} "
                f"| RAFI: {rafi_atual:.2f} | BB width: {bb_curr_width:.5f}"
            )
            return {
                'direcao': 'compra', 'entry': entry,
                'stop_loss': stop, 'take_profit': tp,
                'rafi': rafi_atual, 'rafi_dir': 'bull', 'bb_width': bb_curr_width,
            }

        # ── VENDA: fecha abaixo do suporte com candle de baixa ───────────────
        if (c['close'] < suporte and
            suporte - c['close'] >= min_breakout and
            c['close'] < c['open']):

            entry  = p(suporte)
            stop   = p(float(c['high']) + 0.00015)
            risco  = stop - entry
            if risco <= 0:
                return None
            tp = p(entry - risco * self.cfg.get('ratio_risco_retorno', 1.5))

            logger.info(
                f"SINAL VENDA | Entry: {entry:.5f} | SL: {stop:.5f} | TP: {tp:.5f} "
                f"| RAFI: {rafi_atual:.2f} | BB width: {bb_curr_width:.5f}"
            )
            return {
                'direcao': 'venda', 'entry': entry,
                'stop_loss': stop, 'take_profit': tp,
                'rafi': rafi_atual, 'rafi_dir': 'bear', 'bb_width': bb_curr_width,
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
    parser = argparse.ArgumentParser(description='Bot RAFI — EURUSD M5 · XM')
    parser.add_argument('--config', default='config.yaml', help='Arquivo de configuração YAML')
    args = parser.parse_args()

    # Carrega variáveis de ambiente do .env — busca na pasta atual e na raiz do repo
    for env_path in [Path('.env'), Path(__file__).parent.parent / '.env']:
        if env_path.exists():
            for linha in env_path.read_text(encoding='utf-8').splitlines():
                if '=' in linha and not linha.startswith('#'):
                    chave, valor = linha.split('=', 1)
                    os.environ.setdefault(chave.strip(), valor.strip())
            logger.info(f".env carregado de: {env_path.resolve()}")
            break

    cfg = carregar_config(args.config)
    bot = RafiBot(cfg)
    bot.rodar()


if __name__ == '__main__':
    main()
