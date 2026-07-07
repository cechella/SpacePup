"""
backtest/engine.py — Motor de backtesting da estratégia RAFI

Simula a execução do bot em dados históricos M5 do EURUSD, sem
lookahead bias: cada decisão é tomada apenas com dados disponíveis
no fechamento do candle atual.

Inclui spread real da XM (~0,6–1,6 pips) e slippage estimado.

Estratégia implementada (manuais RAFI — modo M5 agressivo):
  Filtro 0: Sessão ativa (07–09h ou 12–16h UTC)
  Filtro 1: M5 — MA20 vs MA50 define direção (limiar 3 pips)
  Filtro 2: RAFI > +2.50 confirma força do movimento
  Filtro 2b: Cor do candle confirma direção (verde=compra, vermelho=venda)
  Filtro 3: Rompimento de S/R dinâmico (máximo/mínimo dos últimos 50 candles M5)
  Stop-loss: nível de S/R rompido
  Take-profit: ratio_risco_retorno × risco

Performance: todos os indicadores são pré-calculados uma única vez (O(n))
para que o loop principal execute em tempo linear em vez de quadrático.

Uso:
  from backtest.engine import Backtest
  bt = Backtest(config, df_m5, df_m15)
  trades = bt.executar()
  from backtest.report import gerar_relatorio
  relatorio = gerar_relatorio(trades, capital_inicial=20.0)
"""

import logging
import pandas as pd
import numpy as np
from datetime import datetime, timezone
from typing import Optional

from src.indicators import calcular_indice_forca, calcular_bollinger, bollinger_estreitas_abrindo
from src.strategy import calcular_stops, verificar_saida
from src.risk_manager import GestorRisco

logger = logging.getLogger(__name__)


class Backtest:
    """
    Executa o backtest da estratégia RAFI em dados históricos.

    Parâmetros:
      config  : dict de configuração (config.yaml)
      df_m5   : DataFrame M5 com colunas [open, high, low, close, volume]
                Index deve ser DatetimeTZAware (UTC)
      df_m15  : DataFrame M15 (mesmo período — reamostrado automaticamente de M5 se necessário)
      capital : capital inicial em USD
    """

    def __init__(self,
                 config: dict,
                 df_m5: pd.DataFrame,
                 df_m15: pd.DataFrame,
                 capital: float = 20.0):
        self.config    = config
        self.df_m5     = df_m5.copy()
        self.df_m15    = df_m15.copy()
        self.capital   = capital
        self.capital_inicial = capital

        self.gestor = GestorRisco(config)

        # Parâmetros de custo
        self.spread_pips   = float(config.get('spread_pips', 0.8))
        self.slippage_pips = float(config.get('slippage_pips', 0.5))
        self.custo_total   = (self.spread_pips + self.slippage_pips) * 0.0001
        self.par           = config.get('par', 'EURUSD')

        # Registros
        self.trades: list[dict] = []
        self.equity_curve: list = [(self.df_m5.index[0], capital)]

    # ─────────────────────────────────────────────────────────
    # UTILITÁRIOS
    # ─────────────────────────────────────────────────────────

    @staticmethod
    def _resample_para_m15(df_m5: pd.DataFrame) -> pd.DataFrame:
        """
        Reamostara dados M5 para M15 via agregação OHLCV.

        Usado quando df_m15 não é fornecido separadamente — o backtest pode
        funcionar com apenas o CSV M5, reamostrado internamente para M15.
        """
        return df_m5.resample('15min').agg({
            'open'  : 'first',
            'high'  : 'max',
            'low'   : 'min',
            'close' : 'last',
            'volume': 'sum',
        }).dropna()

    # ─────────────────────────────────────────────────────────
    # EXECUÇÃO PRINCIPAL (O(n) via pré-cálculo vetorizado)
    # ─────────────────────────────────────────────────────────

    def executar(self, min_candles: int = 100) -> list:
        """
        Itera candle a candle no M5 e simula a estratégia RAFI completa.

        Filtros em ordem (modo M5 agressivo — sem M15, sem Bollinger):
          0. Sessão ativa: 07–09h ou 12–16h UTC
          1. M5: MA20 vs MA50 com threshold de 3 pips define direção
          2. RAFI > +2.50: confirma força do movimento
          2b. Cor do candle: verde para compra, vermelho para venda
          3. Rompimento de S/R: close cruza máximo ou mínimo dos últimos 50 candles

        Todos os indicadores são pré-calculados uma única vez no início.

        Retorna lista de dicts com todos os trades executados.
        """
        n = len(self.df_m5)

        # ── Pré-cálculo de indicadores (O(n)) ─────────────────
        logger.info("Pré-calculando indicadores (RAFI, MA20/50 M5, S/R)...")

        # Índice de força RAFI no M5
        forca_serie = calcular_indice_forca(self.df_m5)

        # Parâmetros de médias móveis
        ma_r = int(self.config.get('ma_rapida', 20))
        ma_l = int(self.config.get('ma_lenta',  50))

        # Tendência M5: MA20 vs MA50 com threshold configurável
        ma_threshold = float(self.config.get('ma_threshold', 0.0003))
        ma20_m5 = self.df_m5['close'].rolling(ma_r).mean()
        ma50_m5 = self.df_m5['close'].rolling(ma_l).mean()
        diff_m5 = ma20_m5 - ma50_m5
        trend_m5 = pd.Series(0, index=self.df_m5.index, dtype=int)
        trend_m5[diff_m5 >  ma_threshold] = 1
        trend_m5[diff_m5 < -ma_threshold] = -1

        # S/R dinâmico: máximo e mínimo dos últimos sr_lookback candles (shift=1 evita lookahead)
        # Usar sr_lookback do config (padrão 50 = 250 min ≈ 4h de histórico local)
        sr_lookback  = int(self.config.get('sr_lookback', 50))
        rolling_high = self.df_m5['high'].rolling(sr_lookback).max().shift(1)
        rolling_low  = self.df_m5['low'].rolling(sr_lookback).min().shift(1)

        # Swing stop: fundo/topo recente para colocar o stop na estrutura do mercado.
        # Testado: stop no S/R rompido (5-10p) deu WR menor porque o preço retesta
        # naturalmente o nível rompido. Swing stop de 75c dá "room to breathe".
        swing_stop_lb   = int(self.config.get('swing_stop_lookback', 75))
        swing_stop_low  = self.df_m5['low'].rolling(swing_stop_lb).min().shift(1)
        swing_stop_high = self.df_m5['high'].rolling(swing_stop_lb).max().shift(1)

        # Ratio corpo/range: filtra candles de indecisão (dojis, pinos)
        # Candle de breakout genuíno tem corpo grande em relação ao range total
        _candle_range = (self.df_m5['high'] - self.df_m5['low']).replace(0, np.nan)
        corpo_ratio = (self.df_m5['close'] - self.df_m5['open']).abs() / _candle_range
        corpo_ratio = corpo_ratio.fillna(0.0)

        # Bandas de Bollinger — timing de entrada (squeeze + abertura)
        bb = calcular_bollinger(
            self.df_m5,
            periodo=int(self.config.get('bb_periodo', 8)),
            desvios=float(self.config.get('bb_desvios', 2.0)),
        )
        bb_abrindo = bollinger_estreitas_abrindo(
            bb,
            limiar_estreita=float(self.config.get('bb_limiar_estreita', 0.0020)),
            abertura_minima=float(self.config.get('bb_abertura_minima', 0.0003)),
            lookback=int(self.config.get('bb_lookback', 3)),
        )

        # ─── Pré-cálculo EPM (EMA Pullback Momentum) ──────────
        # Estratégia alternativa: entra na recuperação após pullback à EMA21
        # WR esperado: 50-55% (vs 33-37% do RAFI S/R breakout)
        modo = self.config.get('estrategia_modo', 'rafi')
        if modo == 'epm':
            epm_ema_r   = int(self.config.get('epm_ema_rapida',    21))
            epm_ema_l   = int(self.config.get('epm_ema_lenta',     55))
            epm_slope_p = int(self.config.get('epm_slope_periodo',  5))
            epm_pb_lb   = int(self.config.get('pullback_lookback',  15))
            epm_threshold = float(self.config.get('epm_threshold',    0.0005))
            epm_slope_min = float(self.config.get('epm_slope_minimo', 0.00002))
            epm_pb_min    = float(self.config.get('pullback_minimo',  0.0003))
            epm_rec_buf   = float(self.config.get('recovery_buffer',  0.0001))

            ema_fast  = self.df_m5['close'].ewm(span=epm_ema_r, adjust=False).mean()
            ema_slow  = self.df_m5['close'].ewm(span=epm_ema_l, adjust=False).mean()
            ema_slope = ema_fast.diff(epm_slope_p)

            # Quanto o close ficou abaixo (buy) ou acima (sell) da EMA21 na janela
            close_vs_ema  = self.df_m5['close'] - ema_fast
            pb_depth_buy  = close_vs_ema.rolling(epm_pb_lb).min().shift(1)   # negativo = abaixo da EMA
            pb_depth_sell = close_vs_ema.rolling(epm_pb_lb).max().shift(1)   # positivo = acima da EMA

            # SL no fundo/topo do pullback (mais apertado que swing_stop=150)
            epm_sl_low  = self.df_m5['low'].rolling(epm_pb_lb).min().shift(1)
            epm_sl_high = self.df_m5['high'].rolling(epm_pb_lb).max().shift(1)
        else:
            # Valores dummy para não quebrar referências abaixo no modo RAFI/SCALP
            ema_fast = ema_slow = ema_slope = None
            pb_depth_buy = pb_depth_sell = epm_sl_low = epm_sl_high = None
            epm_threshold = epm_slope_min = epm_pb_min = epm_rec_buf = 0.0
            epm_pb_lb = 15

        # ─── Pré-cálculo SCALP (alta frequência com TP/SL fixos) ──────────
        # EMA9/21/50 para alinhamento + ATR(14) para filtro de tamanho + RSI(7)
        if modo == 'scalp':
            scalp_ema_c_p   = int(self.config.get('scalp_ema_curta',    9))
            scalp_ema_m_p   = int(self.config.get('scalp_ema_media',   21))
            scalp_ema_l_p   = int(self.config.get('scalp_ema_longa',   50))
            scalp_rsi_p     = int(self.config.get('scalp_rsi_periodo',  7))
            scalp_atr_p     = int(self.config.get('scalp_atr_periodo', 14))
            scalp_tp_pips   = float(self.config.get('scalp_tp_pips',  10.0))
            scalp_sl_pips   = float(self.config.get('scalp_sl_pips',  10.0))
            scalp_atr_min   = float(self.config.get('scalp_atr_min',   0.3))
            scalp_rsi_filtro = bool(self.config.get('scalp_rsi_filtro', True))

            ema_c = self.df_m5['close'].ewm(span=scalp_ema_c_p, adjust=False).mean()
            ema_m = self.df_m5['close'].ewm(span=scalp_ema_m_p, adjust=False).mean()
            ema_l = self.df_m5['close'].ewm(span=scalp_ema_l_p, adjust=False).mean()

            # True Range e ATR (suavização de Wilder)
            tr = pd.concat([
                self.df_m5['high'] - self.df_m5['low'],
                (self.df_m5['high'] - self.df_m5['close'].shift(1)).abs(),
                (self.df_m5['low']  - self.df_m5['close'].shift(1)).abs(),
            ], axis=1).max(axis=1)
            atr_serie = tr.ewm(span=scalp_atr_p, adjust=False).mean()

            # RSI(7) via Wilder smoothing
            delta      = self.df_m5['close'].diff()
            gain       = delta.clip(lower=0).ewm(span=scalp_rsi_p, adjust=False).mean()
            loss_sr    = (-delta.clip(upper=0)).ewm(span=scalp_rsi_p, adjust=False).mean()
            rsi_serie  = (100 - 100 / (1 + gain / loss_sr.replace(0, np.nan))).fillna(50.0)
        else:
            ema_c = ema_m = ema_l = atr_serie = rsi_serie = None
            scalp_tp_pips = scalp_sl_pips = scalp_atr_min = 0.0
            scalp_rsi_filtro = False
            scalp_ema_l_p = scalp_atr_p = 0

        # ─── Pré-cálculo RSI_REV (mean-reversion por extremos de RSI) ────────
        # RSI(N) muito curto (3-5 candles) oscila violentamente em M5.
        # Quando chega a extremos (< oversold ou > overbought), espera-se reversão.
        # Pesquisa Connors (2009): RSI(3) < 10 → WR 65-72% em mean-reversion.
        if modo == 'rsi_rev':
            rsi_rev_p       = int(self.config.get('rsi_rev_periodo',      3))
            rsi_rev_os      = float(self.config.get('rsi_rev_oversold',  15.0))
            rsi_rev_ob      = float(self.config.get('rsi_rev_overbought', 85.0))
            rsi_rev_tp      = float(self.config.get('rsi_rev_tp_pips',   10.0))
            rsi_rev_sl      = float(self.config.get('rsi_rev_sl_pips',   10.0))
            rsi_rev_ema_p   = int(self.config.get('rsi_rev_ema_tendencia', 0))
            # invertir=True: segue o momentum (RSI>ob=BUY, RSI<os=SELL) em vez de fade
            rsi_rev_inv     = bool(self.config.get('rsi_rev_invertir', False))

            delta_r   = self.df_m5['close'].diff()
            gain_r    = delta_r.clip(lower=0).ewm(span=rsi_rev_p, adjust=False).mean()
            loss_r    = (-delta_r.clip(upper=0)).ewm(span=rsi_rev_p, adjust=False).mean()
            rsi_rev_s = (100 - 100 / (1 + gain_r / loss_r.replace(0, np.nan))).fillna(50.0)

            # Filtro de tendência opcional: EMA longa define macro-direção
            # Se rsi_rev_ema_tendencia=200, só compra acima da EMA200 e só vende abaixo
            if rsi_rev_ema_p > 0:
                ema_rr_tend = self.df_m5['close'].ewm(span=rsi_rev_ema_p, adjust=False).mean()
            else:
                ema_rr_tend = None
        else:
            rsi_rev_s = None
            rsi_rev_p = rsi_rev_ema_p = 0
            rsi_rev_os = rsi_rev_ob = 0.0
            rsi_rev_tp = rsi_rev_sl = 10.0
            ema_rr_tend = None

        # Parâmetros globais
        forca_limiar       = float(self.config.get('forca_limiar',         2.50))
        forca_exaust       = float(self.config.get('forca_exaustao',      -2.50))
        ratio_rr           = float(self.config.get('ratio_risco_retorno',   1.5))
        corpo_minimo       = float(self.config.get('candle_corpo_minimo',   0.0))
        max_stop_pips          = float(self.config.get('max_stop_pips',          0.0))
        max_duracao_candles    = int(self.config.get('max_duracao_candles',     0))
        max_trades_simultaneos = int(self.config.get('max_trades_simultaneos',  1))
        breakeven_stop_ativo   = bool(self.config.get('breakeven_stop_ativo',   False))
        breakeven_gatilho_r    = float(self.config.get('breakeven_gatilho_r',   1.0))
        # Proteção de drawdown: quando capital cai X% do pico, reduz para 1 posição simultânea
        drawdown_protecao      = bool(self.config.get('drawdown_protecao',      False))
        drawdown_limite        = float(self.config.get('drawdown_reducao_pct',  0.40))
        # Capital mínimo operacional: não abre novas posições abaixo deste valor
        capital_minimo_op      = float(self.config.get('capital_minimo_operacional', 0.0))

        # Garante que o loop começa após todos os indicadores estarem válidos
        # (rolling(N) precisa de N candles; shift(1) adiciona 1 extra)
        min_candles = max(min_candles, ma_l, sr_lookback, swing_stop_lb,
                          scalp_ema_l_p, scalp_atr_p) + 5

        # Sessões ativas lidas do config (fallback: London/NY 12-16h)
        sessoes_config = self.config.get('sessoes', {})
        sessoes_minutos: list[tuple[int, int]] = []
        for _, s in sessoes_config.items():
            ini_h, ini_m = map(int, s['inicio'].split(':'))
            fim_h, fim_m = map(int, s['fim'].split(':'))
            sessoes_minutos.append((ini_h * 60 + ini_m, fim_h * 60 + fim_m))
        if not sessoes_minutos:
            sessoes_minutos = [(720, 960)]  # 12:00–16:00 UTC
        logger.info(f"Sessões ativas: {[f'{s//60:02d}:{s%60:02d}–{e//60:02d}:{e%60:02d}' for s, e in sessoes_minutos]}")

        # Suporte a múltiplas posições simultâneas
        posicoes_abertas: list[dict] = []
        forca_anterior: float = 0.0
        # Rastreamento do pico de capital para proteção de drawdown
        capital_pico: float = self.capital

        # Contadores de diagnóstico
        _d_total = _d_sessao = _d_risco = _d_trend = _d_rafi = _d_bb = _d_cor = _d_corpo = _d_sr = 0

        logger.info(
            f"Iniciando backtest | Período: {self.df_m5.index[0]} → {self.df_m5.index[-1]} "
            f"| Candles M5: {n} | Capital: ${self.capital:.2f} | Max simultâneos: {max_trades_simultaneos}"
        )

        for i in range(min_candles, n):
            timestamp   = self.df_m5.index[i]
            close_atual = float(self.df_m5['close'].iloc[i])
            open_atual  = float(self.df_m5['open'].iloc[i])
            forca_val   = forca_serie.iloc[i]
            forca_atual = float(forca_val) if not np.isnan(forca_val) else 0.0

            ts_dt = timestamp.to_pydatetime() if hasattr(timestamp, 'to_pydatetime') \
                    else datetime.fromtimestamp(timestamp.timestamp(), tz=timezone.utc)

            # ── Verificar saída de todas as posições abertas ───
            posicoes_a_fechar = []
            for posicao in list(posicoes_abertas):
                # Saída por duração máxima (evita trades multi-semanas com TP inalcançável)
                if max_duracao_candles > 0:
                    duracao = i - posicao.get('indice_entrada', i)
                    if duracao >= max_duracao_candles:
                        posicoes_a_fechar.append(
                            (posicao,
                             f"Duração máxima ({max_duracao_candles}c/{max_duracao_candles*5//60}h) atingida")
                        )
                        continue

                # Breakeven stop: após +1R de lucro, move SL para preço de entrada
                # Converte perdas totais em empate → melhora WR efetivo sem mudar sinal
                if breakeven_stop_ativo and not posicao.get('breakeven_atingido', False):
                    entrada  = posicao['preco_entrada']
                    risco_pr = posicao['risco_pips'] * 0.0001 * breakeven_gatilho_r
                    if posicao['sinal'] == 'compra' and close_atual >= entrada + risco_pr:
                        posicao['stop_loss']          = entrada + self.custo_total
                        posicao['breakeven_atingido'] = True
                        logger.debug(f"Breakeven atingido (compra) → SL={posicao['stop_loss']:.5f}")
                    elif posicao['sinal'] == 'venda' and close_atual <= entrada - risco_pr:
                        posicao['stop_loss']          = entrada - self.custo_total
                        posicao['breakeven_atingido'] = True
                        logger.debug(f"Breakeven atingido (venda) → SL={posicao['stop_loss']:.5f}")

                posicao['forca_anterior'] = forca_anterior
                saida = verificar_saida(close_atual, posicao, forca_atual, forca_exaust)
                if saida['fechar']:
                    posicoes_a_fechar.append((posicao, saida['motivo']))

            for posicao, motivo in posicoes_a_fechar:
                self._fechar_posicao(posicao, close_atual, ts_dt, motivo)
                posicoes_abertas.remove(posicao)

            forca_anterior = forca_atual

            # Avança a data do gestor de risco (reset diário — sempre, independente de posições)
            self.gestor.avancar_data(ts_dt.date())

            # Atualiza pico de capital e calcula limite dinâmico de posições
            if self.capital > capital_pico:
                capital_pico = self.capital
            if drawdown_protecao and capital_pico > 0:
                # Quando drawdown ≥ limite: reduz para 1 posição (protege capital acumulado)
                drawdown_atual = (capital_pico - self.capital) / capital_pico
                max_pos_agora = 1 if drawdown_atual >= drawdown_limite else max_trades_simultaneos
            else:
                max_pos_agora = max_trades_simultaneos

            # Não busca novo sinal se já no máximo de posições simultâneas
            if len(posicoes_abertas) >= max_pos_agora:
                continue

            _d_total += 1

            # ── Filtro 0: Sessão ativa ─────────────────────────
            hora_min = ts_dt.hour * 60 + ts_dt.minute
            em_sessao = any(ini <= hora_min < fim for ini, fim in sessoes_minutos)
            if not em_sessao:
                continue
            _d_sessao += 1

            # ── Verificar permissão do gestor de risco ─────────
            pode, _ = self.gestor.pode_operar(self.capital)
            if not pode:
                continue
            _d_risco += 1

            # ── Guard: capital mínimo operacional ──────────────
            # Evita operar quando capital é tão baixo que o lote mínimo
            # representa risco desproporcional (>50-100% do capital)
            if capital_minimo_op > 0 and self.capital < capital_minimo_op:
                continue

            # ── Geração de sinal: EPM ou RAFI ─────────────────
            if modo == 'epm':
                # ── EPM Filtro 1: Tendência EMA21 > EMA55 ─────────
                ema_f = float(ema_fast.iloc[i])
                ema_s = float(ema_slow.iloc[i])
                ema_gap_val = ema_f - ema_s
                if abs(ema_gap_val) < epm_threshold:
                    continue
                direcao = 'compra' if ema_gap_val > 0 else 'venda'
                _d_trend += 1

                # ── EPM Filtro 2: Slope da EMA21 positivo/negativo ─
                slope_val = float(ema_slope.iloc[i]) if not np.isnan(ema_slope.iloc[i]) else 0.0
                if direcao == 'compra' and slope_val <= epm_slope_min:
                    continue
                if direcao == 'venda' and slope_val >= -epm_slope_min:
                    continue
                _d_rafi += 1

                # ── EPM Filtro 3: Pullback FRESCO — candle i-1 ou i-2 cruzou a EMA21 ─
                # Evita "sinais velhos": o pullback deve ter acontecido nos últimos 2 candles (10 min),
                # não em algum momento nos últimos 15 (75 min) — que gera dead-cat bounces.
                prev1_c = float(self.df_m5['close'].values[i - 1])
                prev1_e = float(ema_fast.values[i - 1])
                prev2_c = float(self.df_m5['close'].values[i - 2])
                prev2_e = float(ema_fast.values[i - 2])
                if direcao == 'compra':
                    pb1 = (prev1_c - prev1_e) < -epm_pb_min
                    pb2 = (prev2_c - prev2_e) < -epm_pb_min
                    if not pb1 and not pb2:
                        continue
                else:
                    pb1 = (prev1_c - prev1_e) > epm_pb_min
                    pb2 = (prev2_c - prev2_e) > epm_pb_min
                    if not pb1 and not pb2:
                        continue
                _d_bb += 1

                # ── EPM Filtro 4: Recuperação acima da EMA21 ──────
                if direcao == 'compra' and close_atual < ema_f + epm_rec_buf:
                    continue
                if direcao == 'venda' and close_atual > ema_f - epm_rec_buf:
                    continue
                _d_cor += 1

                # ── EPM Filtro 5: Candle anterior confirma cruzamento limpo ──
                # O candle imediatamente anterior (i-1) deve estar do lado oposto da EMA21:
                # confirma que houve uma travessia real, não apenas oscilação em torno da EMA.
                prev_c = float(self.df_m5['close'].values[i - 1])
                prev_e = float(ema_fast.values[i - 1])
                if direcao == 'compra' and prev_c >= prev_e:
                    continue
                if direcao == 'venda' and prev_c <= prev_e:
                    continue
                _d_corpo += 1

                # ── EPM Filtro 6: Cor do candle confirma direção ──
                candle_verde = close_atual > open_atual
                if direcao == 'compra' and not candle_verde:
                    continue
                if direcao == 'venda' and candle_verde:
                    continue
                _d_sr += 1

                # SL no low/high do candle de pullback (candle anterior) — stop apertado e preciso
                nivel_sr   = ema_f
                nivel_stop = (float(self.df_m5['low'].values[i - 1])  if direcao == 'compra'
                              else float(self.df_m5['high'].values[i - 1]))

                sinal_info = {
                    'sinal'         : direcao,
                    'nivel_sr'      : nivel_sr,
                    'nivel_stop'    : nivel_stop,
                    'forca'         : slope_val,
                    'indice_entrada': i,
                }
                nova_posicao = self._abrir_posicao(sinal_info, close_atual, ts_dt, ratio_rr, max_stop_pips)
                if nova_posicao is not None:
                    posicoes_abertas.append(nova_posicao)

            elif modo == 'scalp':
                # ── SCALP: alta frequência EMA9/21/50 + ATR + RSI ──
                ema_c_val = float(ema_c.iloc[i])
                ema_m_val = float(ema_m.iloc[i])
                ema_l_val = float(ema_l.iloc[i])

                # Filtro 1: Alinhamento EMA21 vs EMA50 define a macro-tendência
                if ema_m_val > ema_l_val:
                    direcao = 'compra'
                elif ema_m_val < ema_l_val:
                    direcao = 'venda'
                else:
                    continue
                _d_trend += 1

                # Filtro 2: Preço acima/abaixo da EMA9 (micro-tendência alinhada)
                if direcao == 'compra' and close_atual <= ema_c_val:
                    continue
                if direcao == 'venda' and close_atual >= ema_c_val:
                    continue
                _d_rafi += 1

                # Filtro 3: Cor do candle confirma a direção do trade
                candle_verde = close_atual > open_atual
                if direcao == 'compra' and not candle_verde:
                    continue
                if direcao == 'venda' and candle_verde:
                    continue
                _d_bb += 1

                # Filtro 4: Corpo do candle >= scalp_atr_min × ATR (filtra micro-ruído)
                atr_val    = float(atr_serie.iloc[i]) if not np.isnan(atr_serie.iloc[i]) else 0.0
                corpo_size = abs(close_atual - open_atual)
                if scalp_atr_min > 0 and atr_val > 0 and corpo_size < scalp_atr_min * atr_val:
                    continue
                _d_cor += 1

                # Filtro 5: RSI(7) confirma momentum (opcional)
                if scalp_rsi_filtro:
                    rsi_val = float(rsi_serie.iloc[i]) if not np.isnan(rsi_serie.iloc[i]) else 50.0
                    if direcao == 'compra' and rsi_val <= 50.0:
                        continue
                    if direcao == 'venda' and rsi_val >= 50.0:
                        continue
                _d_corpo += 1
                _d_sr    += 1

                # TP e SL fixos em pips — sem dependência de estrutura de mercado
                pip = 0.0001
                if direcao == 'compra':
                    preco_entrada_s = close_atual + self.custo_total
                    stop_loss_s     = preco_entrada_s - scalp_sl_pips * pip
                    take_profit_s   = preco_entrada_s + scalp_tp_pips * pip
                else:
                    preco_entrada_s = close_atual - self.custo_total
                    stop_loss_s     = preco_entrada_s + scalp_sl_pips * pip
                    take_profit_s   = preco_entrada_s - scalp_tp_pips * pip

                lote = self.gestor.calcular_lote(self.capital, scalp_sl_pips, incluir_spread=True)
                if lote <= 0:
                    continue
                risco_usd = round(scalp_sl_pips * lote * 10.0, 2)
                self.gestor.abrir_trade()

                posicao = {
                    'sinal'            : direcao,
                    'preco_entrada'    : preco_entrada_s,
                    'stop_loss'        : stop_loss_s,
                    'take_profit'      : take_profit_s,
                    'risco_pips'       : scalp_sl_pips,
                    'lote'             : lote,
                    'timestamp_entrada': ts_dt,
                    'capital_entrada'  : self.capital,
                    'forca_entrada'    : corpo_size / atr_val if atr_val > 0 else 0.0,
                    'forca_anterior'   : 0.0,
                    'indice_entrada'   : i,
                }
                posicoes_abertas.append(posicao)
                logger.info(
                    f"[{ts_dt.strftime('%Y-%m-%d %H:%M')}] SCALP {direcao.upper()} "
                    f"| Lote: {lote} | Entrada: {preco_entrada_s:.5f} "
                    f"| SL: {stop_loss_s:.5f} | TP: {take_profit_s:.5f} "
                    f"| Risco: {scalp_sl_pips}p | Risco USD: ${risco_usd:.2f} "
                    f"| Capital: ${self.capital:.2f}"
                )

            elif modo == 'rsi_rev':
                # ── RSI_REV: mean-reversion ou momentum por extremos de RSI(N) ──
                rsi_val_r = float(rsi_rev_s.iloc[i])

                # rsi_rev_inv=True → momentum: RSI extremo segue movimento (TESTE AD)
                # rsi_rev_inv=False → mean-reversion: RSI extremo reverte (TESTE AC)
                if rsi_rev_inv:
                    if rsi_val_r >= rsi_rev_ob:
                        direcao = 'compra'   # RSI sobrecomprado → momentum de alta → compra
                    elif rsi_val_r <= rsi_rev_os:
                        direcao = 'venda'    # RSI sobrevendido → momentum de baixa → venda
                    else:
                        continue
                else:
                    if rsi_val_r <= rsi_rev_os:
                        direcao = 'compra'
                    elif rsi_val_r >= rsi_rev_ob:
                        direcao = 'venda'
                    else:
                        continue
                _d_trend += 1

                # Filtro de tendência opcional (EMA longa): só opera a favor
                if ema_rr_tend is not None:
                    ema_rr_val = float(ema_rr_tend.iloc[i])
                    if direcao == 'compra' and close_atual < ema_rr_val:
                        continue
                    if direcao == 'venda' and close_atual > ema_rr_val:
                        continue
                _d_rafi += 1
                _d_bb    += 1
                _d_cor   += 1
                _d_corpo += 1
                _d_sr    += 1

                # TP e SL fixos em pips
                pip = 0.0001
                if direcao == 'compra':
                    preco_e_r = close_atual + self.custo_total
                    sl_r_v    = preco_e_r - rsi_rev_sl * pip
                    tp_r_v    = preco_e_r + rsi_rev_tp * pip
                else:
                    preco_e_r = close_atual - self.custo_total
                    sl_r_v    = preco_e_r + rsi_rev_sl * pip
                    tp_r_v    = preco_e_r - rsi_rev_tp * pip

                lote = self.gestor.calcular_lote(self.capital, rsi_rev_sl, incluir_spread=True)
                if lote <= 0:
                    continue
                self.gestor.abrir_trade()

                posicao = {
                    'sinal'            : direcao,
                    'preco_entrada'    : preco_e_r,
                    'stop_loss'        : sl_r_v,
                    'take_profit'      : tp_r_v,
                    'risco_pips'       : rsi_rev_sl,
                    'lote'             : lote,
                    'timestamp_entrada': ts_dt,
                    'capital_entrada'  : self.capital,
                    'forca_entrada'    : rsi_val_r,
                    'forca_anterior'   : 0.0,
                    'indice_entrada'   : i,
                }
                posicoes_abertas.append(posicao)
                logger.debug(
                    f"[{ts_dt.strftime('%Y-%m-%d %H:%M')}] RSI_REV {direcao.upper()} "
                    f"| RSI({rsi_rev_p})={rsi_val_r:.1f} | Lote: {lote} "
                    f"| SL: {sl_r_v:.5f} | TP: {tp_r_v:.5f} "
                    f"| Capital: ${self.capital:.2f}"
                )

            else:
                # ── RAFI Filtro 1: Tendência M5 (MA20 vs MA50) ────
                t5 = int(trend_m5.iloc[i])
                if t5 == 0:
                    continue
                _d_trend += 1

                direcao = 'compra' if t5 == 1 else 'venda'

                # ── RAFI Filtro 2: RAFI > limiar confirma força ───
                if forca_atual < forca_limiar:
                    continue
                _d_rafi += 1

                # ── RAFI Filtro 2b: Bollinger abrindo (opcional) ──
                if self.config.get('bb_filtro_ativo', False):
                    if not bool(bb_abrindo.iloc[i]):
                        continue
                    _d_bb += 1

                # ── RAFI Filtro 2c: Cor do candle confirma direção ─
                candle_verde = close_atual > open_atual
                if direcao == 'compra' and not candle_verde:
                    continue
                if direcao == 'venda' and candle_verde:
                    continue
                _d_cor += 1

                # ── RAFI Filtro 2d: Corpo ≥ mínimo (sem dojis/pinos) ─
                if corpo_minimo > 0:
                    if float(corpo_ratio.iloc[i]) < corpo_minimo:
                        _d_corpo += 1
                        continue

                # ── RAFI Filtro 3: Rompimento de S/R dinâmico ─────
                rh = rolling_high.iloc[i]
                rl = rolling_low.iloc[i]
                if pd.isna(rh) or pd.isna(rl):
                    continue
                if direcao == 'compra' and close_atual <= rh:
                    continue
                if direcao == 'venda' and close_atual >= rl:
                    continue
                _d_sr += 1

                nivel_sr = rh if direcao == 'compra' else rl
                nivel_stop = (float(swing_stop_low.iloc[i])  if direcao == 'compra'
                              else float(swing_stop_high.iloc[i]))

                sinal_info = {
                    'sinal'         : direcao,
                    'nivel_sr'      : nivel_sr,
                    'nivel_stop'    : nivel_stop,
                    'forca'         : forca_atual,
                    'indice_entrada': i,
                }
                nova_posicao = self._abrir_posicao(sinal_info, close_atual, ts_dt, ratio_rr, max_stop_pips)
                if nova_posicao is not None:
                    posicoes_abertas.append(nova_posicao)

            # Registrar equity curve diária
            if i % 288 == 0:
                self.equity_curve.append((timestamp, round(self.capital, 2)))

        # Fechar posições ainda abertas ao fim do período
        for posicao in list(posicoes_abertas):
            ultimo_close = float(self.df_m5['close'].iloc[-1])
            self._fechar_posicao(posicao, ultimo_close,
                                 self.df_m5.index[-1], "Fim do período de backtest")

        self.equity_curve.append((self.df_m5.index[-1], round(self.capital, 2)))

        if modo == 'epm':
            logger.info(
                f"[DIAGNÓSTICO EPM] Candles sem posição: {_d_total} "
                f"→ sessão: {_d_sessao} → risco ok: {_d_risco} "
                f"→ trend EMA: {_d_trend} → slope ok: {_d_rafi} "
                f"→ pullback: {_d_bb} → recuperação: {_d_cor} "
                f"→ cruzamento: {_d_corpo} → cor ok: {_d_sr} → trades: {len(self.trades)}"
            )
        elif modo == 'scalp':
            logger.info(
                f"[DIAGNÓSTICO SCALP] Candles sem posição: {_d_total} "
                f"→ sessão: {_d_sessao} → risco ok: {_d_risco} "
                f"→ EMA21>50: {_d_trend} → close>EMA9: {_d_rafi} "
                f"→ cor certa: {_d_bb} → ATR min: {_d_cor} "
                f"→ RSI ok: {_d_corpo} → trades: {len(self.trades)}"
            )
        elif modo == 'rsi_rev':
            tend_info = f"EMA({rsi_rev_ema_p})" if rsi_rev_ema_p > 0 else "sem tendência"
            logger.info(
                f"[DIAGNÓSTICO RSI_REV] Candles: {_d_total} → sessão: {_d_sessao} "
                f"→ risco ok: {_d_risco} → RSI({rsi_rev_p})<{rsi_rev_os}/{rsi_rev_ob}: {_d_trend} "
                f"→ {tend_info}: {_d_rafi} → trades: {len(self.trades)}"
            )
        else:
            logger.info(
                f"[DIAGNÓSTICO RAFI] Candles sem posição: {_d_total} "
                f"→ sessão: {_d_sessao} → risco ok: {_d_risco} "
                f"→ trend M5: {_d_trend} → RAFI>{forca_limiar}: {_d_rafi} "
                f"→ BB abrindo: {_d_bb} → cor ok: {_d_cor} "
                f"→ corpo≥{corpo_minimo:.0%}: {_d_cor - _d_corpo} → S/R rompido: {_d_sr} → trades: {len(self.trades)}"
            )
        logger.info(
            f"Backtest concluído | Trades: {len(self.trades)} | "
            f"Capital final: ${self.capital:.2f}"
        )
        return self.trades

    # ─────────────────────────────────────────────────────────
    # ABERTURA E FECHAMENTO SIMULADOS
    # ─────────────────────────────────────────────────────────

    def _abrir_posicao(self,
                        sinal_info: dict,
                        close_atual: float,
                        timestamp: datetime,
                        ratio_rr: float = 1.5,
                        max_stop_pips: float = 0.0,
                        ) -> Optional[dict]:
        """Simula a abertura de uma posição com custo de spread/slippage."""
        sinal = sinal_info['sinal']

        # Stop na estrutura do mercado (swing low/high) — mais robusto que S/R rompido
        # Fallback para nivel_sr se nivel_stop não estiver disponível
        nivel_stop = sinal_info.get('nivel_stop', sinal_info['nivel_sr'])

        # Preço de entrada com custo de spread/slippage
        if sinal == 'compra':
            preco_entrada = close_atual + self.custo_total
        else:
            preco_entrada = close_atual - self.custo_total

        # Rejeita se nivel_stop for NaN (rolling ainda não aqueceu)
        if nivel_stop is None or np.isnan(nivel_stop):
            logger.debug("nivel_stop NaN — trade ignorado (lookback insuficiente)")
            return None

        stops = calcular_stops(sinal, preco_entrada, nivel_stop, ratio_rr, self.spread_pips)

        if stops['risco_pips'] <= 0 or np.isnan(stops['risco_pips']):
            logger.warning(f"Risco inválido ({stops['risco_pips']}p) — trade ignorado")
            return None

        # Filtro de compressão: skip se SL > max_stop_pips (não clampar — respeitar estrutura)
        # Só entra quando mercado está comprimido → breakouts de compressão têm WR melhor
        if max_stop_pips > 0 and stops['risco_pips'] > max_stop_pips:
            logger.debug(
                f"SL muito largo ({stops['risco_pips']:.0f}p > {max_stop_pips:.0f}p) — skip"
            )
            return None

        lote = self.gestor.calcular_lote(self.capital, stops['risco_pips'], incluir_spread=True)
        risco_usd = round(stops['risco_pips'] * lote * 10.0, 2)
        self.gestor.abrir_trade()

        posicao = {
            'sinal'            : sinal,
            'preco_entrada'    : preco_entrada,
            'stop_loss'        : stops['stop_loss'],
            'take_profit'      : stops['take_profit'],
            'risco_pips'       : stops['risco_pips'],
            'lote'             : lote,
            'timestamp_entrada': timestamp,
            'capital_entrada'  : self.capital,
            'forca_entrada'    : sinal_info.get('forca'),
            'forca_anterior'   : 0.0,
            'indice_entrada'   : sinal_info.get('indice_entrada', 0),
        }

        logger.info(
            f"[{timestamp.strftime('%Y-%m-%d %H:%M')}] ABERTURA {sinal.upper()} "
            f"| Lote: {lote} | Entrada: {preco_entrada:.5f} "
            f"| SL: {stops['stop_loss']:.5f} | TP: {stops['take_profit']:.5f} "
            f"| Risco: {stops['risco_pips']}p | Risco USD: ${risco_usd:.2f} "
            f"| Capital: ${self.capital:.2f}"
        )
        return posicao

    def _fechar_posicao(self,
                         posicao: dict,
                         close_atual: float,
                         timestamp: datetime,
                         motivo: str) -> None:
        """Simula o fechamento e calcula o P&L em USD."""
        sinal         = posicao['sinal']
        lote          = posicao['lote']
        preco_entrada = posicao['preco_entrada']

        if sinal == 'compra':
            preco_saida   = close_atual - self.custo_total / 2
            variacao_pips = (preco_saida - preco_entrada) / 0.0001
        else:
            preco_saida   = close_atual + self.custo_total / 2
            variacao_pips = (preco_entrada - preco_saida) / 0.0001

        # EURUSD: $10/pip por lote padrão (100.000 unidades)
        pnl_usd = round(variacao_pips * lote * 10.0, 2)

        self.capital = round(self.capital + pnl_usd, 2)
        self.gestor.fechar_trade(pnl_usd, self.capital)

        try:
            duracao_candles = int((timestamp - posicao['timestamp_entrada']).total_seconds() / 300)
        except Exception:
            duracao_candles = 0

        self.trades.append({
            'timestamp_entrada': posicao['timestamp_entrada'],
            'timestamp_saida'  : timestamp,
            'sinal'            : sinal,
            'lote'             : lote,
            'preco_entrada'    : preco_entrada,
            'preco_saida'      : round(preco_saida, 5),
            'stop_loss'        : posicao['stop_loss'],
            'take_profit'      : posicao['take_profit'],
            'risco_pips'       : posicao['risco_pips'],
            'variacao_pips'    : round(variacao_pips, 1),
            'pnl_usd'          : pnl_usd,
            'capital_apos'     : self.capital,
            'duracao_candles'  : duracao_candles,
            'motivo_saida'     : motivo,
            'forca_entrada'    : posicao.get('forca_entrada'),
        })

        simbolo = "+" if pnl_usd >= 0 else ""
        logger.info(
            f"[{timestamp.strftime('%Y-%m-%d %H:%M')}] FECHAMENTO | {motivo} "
            f"| Pips: {variacao_pips:+.1f} | P&L: {simbolo}${pnl_usd:.2f} "
            f"| Capital: ${self.capital:.2f}"
        )


class BacktestCSV(Backtest):
    """
    Carrega dados de arquivos CSV exportados do MT5.

    Os CSVs devem ter colunas: Date, Time, Open, High, Low, Close, Volume
    (formato padrão de exportação do MT5).
    """

    @classmethod
    def de_csv(cls,
                config: dict,
                caminho_m5: str,
                caminho_m15: str,
                capital: float = 20.0) -> 'BacktestCSV':
        """Cria uma instância do backtest a partir de arquivos CSV do MT5."""
        df_m5  = cls._carregar_csv(caminho_m5)
        df_m15 = cls._carregar_csv(caminho_m15)

        logger.info(
            f"CSV carregado | M5: {len(df_m5)} | M15: {len(df_m15)}"
        )
        return cls(config, df_m5, df_m15, capital)

    @staticmethod
    def _carregar_csv(caminho: str) -> pd.DataFrame:
        """
        Carrega e normaliza um CSV exportado do MT5.
        Suporta o formato com colunas separadas Date/Time
        e o formato com coluna única '<DATE> <TIME>'.
        """
        df = pd.read_csv(caminho, sep='\t', header=0)
        df.columns = [c.strip().replace('<', '').replace('>', '').lower()
                      for c in df.columns]

        if 'date' in df.columns and 'time' in df.columns:
            df['datetime'] = pd.to_datetime(df['date'] + ' ' + df['time'], utc=True)
        elif 'datetime' in df.columns:
            df['datetime'] = pd.to_datetime(df['datetime'], utc=True)
        else:
            raise ValueError(f"Colunas de data/hora não encontradas em {caminho}")

        df = df.set_index('datetime').sort_index()

        rename = {
            'open': 'open', 'high': 'high', 'low': 'low',
            'close': 'close', 'vol': 'volume', 'volume': 'volume',
            'tickvol': 'volume',
        }
        df = df.rename(columns={k: v for k, v in rename.items() if k in df.columns})

        for col in ['open', 'high', 'low', 'close']:
            if col not in df.columns:
                raise ValueError(f"Coluna '{col}' ausente em {caminho}")

        if 'volume' not in df.columns:
            df['volume'] = 0

        return df[['open', 'high', 'low', 'close', 'volume']].astype(float)
