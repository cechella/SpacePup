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

from src.indicators import calcular_indice_forca
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

        # Tendência M5: MA20 vs MA50 com threshold de 3 pips
        # Threshold evita sinais em mercado lateral (diff insignificante)
        ma20_m5 = self.df_m5['close'].rolling(ma_r).mean()
        ma50_m5 = self.df_m5['close'].rolling(ma_l).mean()
        diff_m5 = ma20_m5 - ma50_m5
        trend_m5 = pd.Series(0, index=self.df_m5.index, dtype=int)
        trend_m5[diff_m5 >  0.0003] = 1
        trend_m5[diff_m5 < -0.0003] = -1

        # S/R dinâmico: máximo e mínimo dos últimos sr_lookback candles (shift=1 evita lookahead)
        # Usar sr_lookback do config (padrão 50 = 250 min ≈ 4h de histórico local)
        sr_lookback  = int(self.config.get('sr_lookback', 50))
        rolling_high = self.df_m5['high'].rolling(sr_lookback).max().shift(1)
        rolling_low  = self.df_m5['low'].rolling(sr_lookback).min().shift(1)

        # Swing stop: fundo/topo recente para colocar o stop na estrutura do mercado
        # Menor lookback que S/R — captura apenas o movimento imediato antes da entrada
        swing_stop_lb   = int(self.config.get('swing_stop_lookback', 15))
        swing_stop_low  = self.df_m5['low'].rolling(swing_stop_lb).min().shift(1)
        swing_stop_high = self.df_m5['high'].rolling(swing_stop_lb).max().shift(1)

        # Parâmetros globais
        forca_limiar = float(self.config.get('forca_limiar',   2.50))
        forca_exaust = float(self.config.get('forca_exaustao', -2.50))
        ratio_rr     = float(self.config.get('ratio_risco_retorno', 1.5))

        posicao_aberta: Optional[dict] = None
        forca_anterior: float = 0.0

        logger.info(
            f"Iniciando backtest | Período: {self.df_m5.index[0]} → {self.df_m5.index[-1]} "
            f"| Candles M5: {n} | Capital: ${self.capital:.2f}"
        )

        for i in range(min_candles, n):
            timestamp   = self.df_m5.index[i]
            close_atual = float(self.df_m5['close'].iloc[i])
            open_atual  = float(self.df_m5['open'].iloc[i])
            forca_val   = forca_serie.iloc[i]
            forca_atual = float(forca_val) if not np.isnan(forca_val) else 0.0

            ts_dt = timestamp.to_pydatetime() if hasattr(timestamp, 'to_pydatetime') \
                    else datetime.fromtimestamp(timestamp.timestamp(), tz=timezone.utc)

            # ── Verificar saída de posição aberta ─────────────
            if posicao_aberta is not None:
                posicao_aberta['forca_anterior'] = forca_anterior
                saida = verificar_saida(close_atual, posicao_aberta, forca_atual, forca_exaust)
                if saida['fechar']:
                    self._fechar_posicao(posicao_aberta, close_atual, ts_dt, saida['motivo'])
                    posicao_aberta = None

            forca_anterior = forca_atual

            if posicao_aberta is not None:
                continue

            # Avança a data do gestor de risco (para reset diário correto no backtest)
            self.gestor.avancar_data(ts_dt.date())

            # ── Filtro 0: Sessão ativa ─────────────────────────
            # Somente sobreposição Londres/NY (12–16 UTC) — maior liquidez e direcionalidade
            # Removida abertura de Londres (07–09 UTC) por excesso de falsos rompimentos
            # (London sweep: preço varre stops antes de reverter na direção real)
            hora_min = ts_dt.hour * 60 + ts_dt.minute
            em_sessao = (720 <= hora_min < 960)
            if not em_sessao:
                continue

            # ── Verificar permissão do gestor de risco ─────────
            pode, _ = self.gestor.pode_operar(self.capital)
            if not pode:
                continue

            # ── Filtro 1: Tendência M5 (MA20 vs MA50) ──────────
            t5 = int(trend_m5.iloc[i])
            if t5 == 0:
                continue  # M5 lateral — não operar

            direcao = 'compra' if t5 == 1 else 'venda'

            # ── Filtro 2: RAFI > +2.50 confirma força ──────────
            # RAFI mede FORÇA, não direção — sempre positivo (0 a +5).
            # > +2.50 é válido para COMPRA e VENDA.
            # A direção é confirmada pela cor do candle (filtro 2b) e pelo
            # rompimento de resistência (compra) ou suporte (venda).
            if forca_atual < forca_limiar:
                continue

            # ── Filtro 2a: Sinal FRESCO (cruzamento recente do limiar) ──
            # Só entra quando o RAFI ACABOU de cruzar +2.50.
            # Candle anterior já acima do limiar = movimento sobreextendido → pular.
            if forca_anterior >= forca_limiar:
                continue

            # ── Filtro 2b: Cor do candle confirma direção ──────
            # Compra → candle verde (fechamento > abertura): preço subiu
            # Venda  → candle vermelho (fechamento < abertura): preço caiu
            # Nunca comprar em candle vermelho com RAFI alto (sinal invertido)
            candle_verde = close_atual > open_atual
            if direcao == 'compra' and not candle_verde:
                continue
            if direcao == 'venda' and candle_verde:
                continue

            # ── Filtro 3: Rompimento de S/R dinâmico ──────────
            # Compra: close supera o máximo dos últimos sr_lookback candles
            # Venda : close cai abaixo do mínimo dos últimos sr_lookback candles
            rh = rolling_high.iloc[i]
            rl = rolling_low.iloc[i]
            if pd.isna(rh) or pd.isna(rl):
                continue
            if direcao == 'compra' and close_atual <= rh:
                continue
            if direcao == 'venda' and close_atual >= rl:
                continue

            # ── Sinal válido — stop na estrutura de mercado ───
            # nivel_sr: nível de S/R rompido (define a entrada)
            # nivel_stop: swing low/high dos últimos N candles (define o stop)
            # Stop distante o suficiente para absorver ruído normal do preço
            nivel_sr = rh if direcao == 'compra' else rl
            nivel_stop = (float(swing_stop_low.iloc[i])  if direcao == 'compra'
                          else float(swing_stop_high.iloc[i]))

            sinal_info = {
                'sinal'     : direcao,
                'nivel_sr'  : nivel_sr,
                'nivel_stop': nivel_stop,
                'forca'     : forca_atual,
            }
            posicao_aberta = self._abrir_posicao(sinal_info, close_atual, ts_dt, ratio_rr)

            # Registrar equity curve diária
            if i % 288 == 0:
                self.equity_curve.append((timestamp, round(self.capital, 2)))

        # Fechar posição aberta ao fim do período
        if posicao_aberta is not None:
            ultimo_close = float(self.df_m5['close'].iloc[-1])
            self._fechar_posicao(
                posicao_aberta, ultimo_close,
                self.df_m5.index[-1], "Fim do período de backtest"
            )

        self.equity_curve.append((self.df_m5.index[-1], round(self.capital, 2)))

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
                        ratio_rr: float = 1.5) -> Optional[dict]:
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

        stops = calcular_stops(sinal, preco_entrada, nivel_stop, ratio_rr, self.spread_pips)

        if stops['risco_pips'] <= 0:
            logger.warning(f"Risco inválido ({stops['risco_pips']}p) — trade ignorado")
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
