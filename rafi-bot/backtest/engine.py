"""
backtest/engine.py — Motor de backtesting da estratégia RAFI

Simula a execução do bot em dados históricos M5 do EURUSD, sem
lookahead bias: cada decisão é tomada apenas com dados disponíveis
no fechamento do candle atual.

Inclui spread real da XM (~0,6–1,6 pips) e slippage estimado.

Uso:
  from backtest.engine import Backtest
  bt = Backtest(config, df_m5, df_m15, df_h1)
  trades = bt.executar()
  from backtest.report import gerar_relatorio
  relatorio = gerar_relatorio(trades, capital_inicial=100.0)
"""

import logging
import pandas as pd
import numpy as np
from datetime import datetime, timezone
from typing import Optional

from src.indicators import (
    calcular_indice_forca,
    calcular_bollinger,
    bollinger_estreitas_abrindo,
    detectar_pivotos,
    niveis_sr_ativos,
    rompimento_ocorreu,
)
from src.strategy import (
    AnalisadorSinal,
    calcular_stops,
    verificar_saida,
    em_sessao_ativa,
)
from src.risk_manager import GestorRisco

logger = logging.getLogger(__name__)


class Backtest:
    """
    Executa o backtest da estratégia RAFI em dados históricos.

    Parâmetros:
      config  : dict de configuração (config.yaml)
      df_m5   : DataFrame M5 com colunas [open, high, low, close, volume]
                Index deve ser DatetimeTZAware (UTC)
      df_m15  : DataFrame M15 (mesmo período)
      df_h1   : DataFrame H1 (mesmo período)
      capital : capital inicial em USD
    """

    def __init__(self,
                 config: dict,
                 df_m5: pd.DataFrame,
                 df_m15: pd.DataFrame,
                 df_h1: pd.DataFrame,
                 capital: float = 20.0):
        self.config    = config
        self.df_m5     = df_m5.copy()
        self.df_m15    = df_m15.copy()
        self.df_h1     = df_h1.copy()
        self.capital   = capital
        self.capital_inicial = capital

        self.analisador = AnalisadorSinal(config)
        self.gestor     = GestorRisco(config)

        # Parâmetros de custo
        self.spread_pips   = float(config.get('spread_pips', 0.8))
        self.slippage_pips = float(config.get('slippage_pips', 0.5))
        self.custo_total   = (self.spread_pips + self.slippage_pips) * 0.0001
        self.par           = config.get('par', 'EURUSD')

        # Registros
        self.trades: list[dict]  = []
        self.equity_curve: list  = [(self.df_m5.index[0], capital)]

    # ─────────────────────────────────────────────────────────
    # EXECUÇÃO PRINCIPAL
    # ─────────────────────────────────────────────────────────

    def executar(self, min_candles: int = 100) -> list:
        """
        Itera candle a candle no M5 e simula a estratégia.

        Retorna lista de dicts com todos os trades executados.
        """
        n = len(self.df_m5)
        posicao_aberta: Optional[dict] = None
        forca_anterior: float = 0.0

        logger.info(
            f"Iniciando backtest | Período: {self.df_m5.index[0]} → {self.df_m5.index[-1]} "
            f"| Candles M5: {n} | Capital: ${self.capital:.2f}"
        )

        for i in range(min_candles, n):
            # Fatia de dados até o candle atual (sem lookahead)
            df5_slice  = self.df_m5.iloc[:i + 1]
            timestamp  = df5_slice.index[-1]

            # Converter para datetime timezone-aware se necessário
            if hasattr(timestamp, 'to_pydatetime'):
                ts_dt = timestamp.to_pydatetime()
            else:
                ts_dt = datetime.fromtimestamp(timestamp.timestamp(), tz=timezone.utc)

            # Fatias M15 e H1 sincronizadas ao timestamp atual
            df15_slice = self._fatiar_por_tempo(self.df_m15, timestamp)
            df1h_slice = self._fatiar_por_tempo(self.df_h1, timestamp)

            close_atual = float(df5_slice['close'].iloc[-1])

            # Calcular índice de força atual para detecção de exaustão
            forca_serie  = calcular_indice_forca(df5_slice)
            forca_atual  = float(forca_serie.iloc[-1]) if not forca_serie.empty else 0.0

            # ── Verificar saída de posição aberta ─────────────
            if posicao_aberta is not None:
                posicao_aberta['forca_anterior'] = forca_anterior
                saida = verificar_saida(
                    close_atual,
                    posicao_aberta,
                    forca_atual,
                    forca_exaustao=float(self.config.get('forca_exaustao', -2.50)),
                )
                if saida['fechar']:
                    self._fechar_posicao(posicao_aberta, close_atual, ts_dt, saida['motivo'])
                    posicao_aberta = None

            # ── Verificar sinal de entrada ─────────────────────
            if posicao_aberta is None and len(df15_slice) >= 50 and len(df1h_slice) >= 50:
                pode, motivo_bloqueio = self.gestor.pode_operar(self.capital)
                if pode:
                    sinal_info = self.analisador.analisar(
                        df5_slice, df15_slice, df1h_slice, ts_dt
                    )
                    if sinal_info['sinal'] != 'nenhum' and sinal_info['nivel_sr'] is not None:
                        posicao_aberta = self._abrir_posicao(
                            sinal_info, close_atual, ts_dt
                        )

            forca_anterior = forca_atual

            # Registrar equity curve a cada 288 candles (≈ 1 dia em M5)
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
                        timestamp: datetime) -> Optional[dict]:
        """Simula a abertura de uma posição com custo de spread/slippage."""
        sinal     = sinal_info['sinal']
        nivel_sr  = sinal_info['nivel_sr']
        ratio_rr  = float(self.config.get('ratio_risco_retorno', 1.5))

        # Preço de entrada com spread/slippage
        if sinal == 'compra':
            preco_entrada = close_atual + self.custo_total  # paga spread no ask
        else:
            preco_entrada = close_atual - self.custo_total  # vende no bid

        stops = calcular_stops(
            sinal, preco_entrada, nivel_sr,
            ratio_rr, self.spread_pips
        )

        if stops['risco_pips'] <= 0:
            logger.warning(f"Risco calculado inválido ({stops['risco_pips']}p) — trade ignorado")
            return None

        lote = self.gestor.calcular_lote(
            self.capital,
            stops['risco_pips'],
            incluir_spread=True
        )

        self.gestor.abrir_trade()

        posicao = {
            'sinal'         : sinal,
            'preco_entrada' : preco_entrada,
            'stop_loss'     : stops['stop_loss'],
            'take_profit'   : stops['take_profit'],
            'risco_pips'    : stops['risco_pips'],
            'lote'          : lote,
            'timestamp_entrada': timestamp,
            'capital_entrada'  : self.capital,
            'forca_entrada'    : sinal_info.get('forca'),
            'forca_anterior'   : 0.0,
        }

        logger.info(
            f"[{timestamp}] ABERTURA {sinal.upper()} | Lote: {lote} | "
            f"Entrada: {preco_entrada:.5f} | SL: {stops['stop_loss']:.5f} | "
            f"TP: {stops['take_profit']:.5f} | Risco: {stops['risco_pips']}p"
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

        # Preço de saída com custo
        if sinal == 'compra':
            preco_saida = close_atual - self.custo_total / 2  # saída no bid
        else:
            preco_saida = close_atual + self.custo_total / 2

        # P&L: para EURUSD, 1 pip = $10 por lote padrão
        if sinal == 'compra':
            variacao_pips = (preco_saida - preco_entrada) / 0.0001
        else:
            variacao_pips = (preco_entrada - preco_saida) / 0.0001

        pnl_usd = variacao_pips * lote * 10.0  # $10/pip por lote padrão
        pnl_usd = round(pnl_usd, 2)

        self.capital = round(self.capital + pnl_usd, 2)
        self.gestor.fechar_trade(pnl_usd, self.capital)

        duracao_candles = 0
        if hasattr(timestamp, '__sub__'):
            try:
                delta = timestamp - posicao['timestamp_entrada']
                duracao_candles = int(delta.total_seconds() / 300)  # M5 = 5 min
            except Exception:
                pass

        trade = {
            'timestamp_entrada': posicao['timestamp_entrada'],
            'timestamp_saida'  : timestamp,
            'sinal'            : sinal,
            'lote'             : lote,
            'preco_entrada'    : posicao['preco_entrada'],
            'preco_saida'      : preco_saida,
            'stop_loss'        : posicao['stop_loss'],
            'take_profit'      : posicao['take_profit'],
            'risco_pips'       : posicao['risco_pips'],
            'variacao_pips'    : round(variacao_pips, 1),
            'pnl_usd'          : pnl_usd,
            'capital_apos'     : self.capital,
            'duracao_candles'  : duracao_candles,
            'motivo_saida'     : motivo,
            'forca_entrada'    : posicao.get('forca_entrada'),
        }
        self.trades.append(trade)

        emoji = "✔" if pnl_usd >= 0 else "✘"
        logger.info(
            f"[{timestamp}] FECHAMENTO {emoji} | {motivo} | "
            f"Pips: {variacao_pips:+.1f} | P&L: ${pnl_usd:+.2f} | "
            f"Capital: ${self.capital:.2f}"
        )

    # ─────────────────────────────────────────────────────────
    # UTILITÁRIOS
    # ─────────────────────────────────────────────────────────

    @staticmethod
    def _fatiar_por_tempo(df: pd.DataFrame, ate: object) -> pd.DataFrame:
        """Retorna o DataFrame filtrado até o timestamp dado (sem lookahead)."""
        try:
            return df[df.index <= ate]
        except Exception:
            return df


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
                caminho_h1: str,
                capital: float = 20.0) -> 'BacktestCSV':
        """
        Cria uma instância do backtest a partir de arquivos CSV.

        Parâmetros:
          config      : dict de configuração
          caminho_*   : caminhos para os CSVs de cada timeframe
          capital     : capital inicial em USD
        """
        df_m5  = cls._carregar_csv(caminho_m5)
        df_m15 = cls._carregar_csv(caminho_m15)
        df_h1  = cls._carregar_csv(caminho_h1)

        logger.info(
            f"CSV carregado | M5: {len(df_m5)} | M15: {len(df_m15)} | H1: {len(df_h1)}"
        )
        return cls(config, df_m5, df_m15, df_h1, capital)

    @staticmethod
    def _carregar_csv(caminho: str) -> pd.DataFrame:
        """
        Carrega e normaliza um CSV exportado do MT5.
        Suporta tanto o formato com colunas separadas Date/Time
        quanto o formato com coluna única '<DATE> <TIME>'.
        """
        df = pd.read_csv(caminho, sep='\t', header=0)

        # Normalizar nomes de colunas
        df.columns = [c.strip().replace('<', '').replace('>', '').lower()
                      for c in df.columns]

        # Montar índice de datetime
        if 'date' in df.columns and 'time' in df.columns:
            df['datetime'] = pd.to_datetime(
                df['date'] + ' ' + df['time'], utc=True
            )
        elif 'datetime' in df.columns:
            df['datetime'] = pd.to_datetime(df['datetime'], utc=True)
        else:
            raise ValueError(f"Colunas de data/hora não encontradas em {caminho}")

        df = df.set_index('datetime').sort_index()

        # Renomear para padrão interno
        rename = {
            'open': 'open', 'high': 'high', 'low': 'low',
            'close': 'close', 'vol': 'volume', 'volume': 'volume',
            'tickvol': 'volume',
        }
        df = df.rename(columns={k: v for k, v in rename.items() if k in df.columns})

        # Garantir colunas necessárias
        for col in ['open', 'high', 'low', 'close']:
            if col not in df.columns:
                raise ValueError(f"Coluna '{col}' ausente em {caminho}")

        if 'volume' not in df.columns:
            df['volume'] = 0

        return df[['open', 'high', 'low', 'close', 'volume']].astype(float)
