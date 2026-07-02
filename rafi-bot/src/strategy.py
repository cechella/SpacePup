"""
strategy.py — Regras de entrada, saída e filtros da estratégia RAFI

Implementa TODAS as condições da Seção 2 do documento mestre:
  - Sessões de sobreposição (Tóquio+Sydney, Tóquio+Londres, Londres+NY)
  - Rompimento de S/R com força RAFI
  - Sincronismo multi-timeframe
  - Timing Bollinger (estreitas abrindo)
  - Saída: stop-loss, take-profit, exaustão, trailing stop
"""

import yaml
import logging
import pandas as pd
from datetime import datetime, timezone
from typing import Optional

from .indicators import (
    calcular_indice_forca,
    calcular_bollinger,
    bollinger_estreitas_abrindo,
    detectar_pivotos,
    niveis_sr_ativos,
    rompimento_ocorreu,
    detectar_exaustao,
)
from .multi_timeframe import verificar_sincronismo

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────
# SESSÕES DE TRADING
# ─────────────────────────────────────────────────────────────

# Sobreposições de sessões em formato (hora_inicio, hora_fim) UTC
# Nota: Tóquio+Sydney cruza a meia-noite → tratado como dois intervalos
SESSOES_UTC = {
    'toquio_sydney_1': (23, 0,   0, 0),   # 23:00 → meia-noite
    'toquio_sydney_2': (0,  0,   1, 0),   # meia-noite → 01:00
    'toquio_londres' : (7,  0,   8, 0),   # 07:00 → 08:00
    'londres_ny'     : (12, 0,  16, 0),   # 12:00 → 16:00
}


def em_sessao_ativa(dt: datetime) -> bool:
    """
    Verifica se o datetime (UTC) está dentro de uma sobreposição de sessão.

    Retorna True apenas se o horário cair em uma das janelas configuradas.
    """
    hora = dt.hour
    minuto = dt.minute
    minutos_totais = hora * 60 + minuto

    for nome, (h_ini, m_ini, h_fim, m_fim) in SESSOES_UTC.items():
        ini = h_ini * 60 + m_ini
        fim = h_fim * 60 + m_fim

        # Sessão Tóquio+Sydney parte 1: 23:00–00:00 (fim = 0 = meia-noite)
        if fim == 0:
            if minutos_totais >= ini:
                return True
        else:
            if ini <= minutos_totais < fim:
                return True

    return False


# ─────────────────────────────────────────────────────────────
# ANÁLISE DE SINAL
# ─────────────────────────────────────────────────────────────

class AnalisadorSinal:
    """
    Analisa um conjunto de candles (M5 base + M15 + H1) e decide se há
    sinal de entrada, retornando a direção e os parâmetros de trade.
    """

    def __init__(self, config: dict):
        self.cfg = config
        ind = config.get('indicadores', config)  # compatível com config flat ou aninhado
        self.forca_limiar  = float(config.get('forca_limiar', 2.50))
        self.forca_exaust  = float(config.get('forca_exaustao', -2.50))
        self.bb_periodo    = int(config.get('bollinger_periodo', 8))
        self.bb_desvios    = float(config.get('bollinger_desvios', 2.0))
        self.bb_estreita   = float(config.get('bollinger_limiar_largura', 0.0010))
        self.bb_abertura   = float(config.get('bollinger_abertura_minima', 0.0003))
        self.sr_lookback   = int(config.get('sr_lookback', 50))
        self.sr_tolerancia = float(config.get('sr_tolerancia', 0.0005))
        self.ma_rapida     = int(config.get('ma_rapida', 20))
        self.ma_lenta      = int(config.get('ma_lenta', 50))

    def analisar(self,
                 df_m5: pd.DataFrame,
                 df_m15: pd.DataFrame,
                 df_h1: pd.DataFrame,
                 timestamp: Optional[datetime] = None) -> dict:
        """
        Executa a análise completa e retorna um dict de sinal.

        Parâmetros:
          df_m5   : DataFrame M5 com colunas [open, high, low, close, volume]
          df_m15  : DataFrame M15
          df_h1   : DataFrame H1
          timestamp: datetime UTC do candle atual (usa o último índice de df_m5 se None)

        Retorna dict com:
          'sinal'    : 'compra' | 'venda' | 'nenhum'
          'motivo'   : str explicando a decisão (aceita ou descartada)
          'forca'    : float — índice de força no candle atual
          'close'    : float — preço de fechamento atual
          'nivel_sr' : float — nível S/R rompido (ou None)
          'bb_largura': float — largura atual das Bandas de Bollinger
        """
        if timestamp is None:
            idx = df_m5.index[-1]
            timestamp = idx if isinstance(idx, datetime) else datetime.utcnow()

        # Resultado base
        resultado = {
            'sinal'    : 'nenhum',
            'motivo'   : '',
            'forca'    : None,
            'close'    : float(df_m5['close'].iloc[-1]),
            'nivel_sr' : None,
            'bb_largura': None,
            'timestamp': timestamp,
        }

        # ── Filtro 1: Sessão ativa ──────────────────────────────────
        if not em_sessao_ativa(timestamp):
            resultado['motivo'] = f"Fora de sessão ({timestamp.strftime('%H:%M')} UTC)"
            logger.debug(resultado['motivo'])
            return resultado

        # ── Filtro 2: Sincronismo multi-timeframe ───────────────────
        dfs = {'M5': df_m5, 'M15': df_m15, 'H1': df_h1}
        sync = verificar_sincronismo(dfs, self.ma_rapida, self.ma_lenta)
        if not sync['sincronizado']:
            resultado['motivo'] = (
                f"Timeframes não sincronizados: {sync['tendencias']}"
            )
            logger.debug(resultado['motivo'])
            return resultado

        direcao_mercado = sync['direcao']  # 'compra' ou 'venda'

        # ── Cálculo de indicadores no M5 ───────────────────────────
        forca = calcular_indice_forca(df_m5)
        forca_atual = float(forca.iloc[-1])
        resultado['forca'] = forca_atual

        bb    = calcular_bollinger(df_m5, self.bb_periodo, self.bb_desvios)
        resultado['bb_largura'] = float(bb['bb_largura'].iloc[-1])

        # ── Filtro 3: Força RAFI suficiente ────────────────────────
        if forca_atual < self.forca_limiar:
            resultado['motivo'] = (
                f"Força insuficiente: {forca_atual:.2f} < {self.forca_limiar}"
            )
            logger.debug(resultado['motivo'])
            return resultado

        # ── Filtro 4: Rompimento de S/R ────────────────────────────
        pivotos = detectar_pivotos(df_m5, janela=5)
        niveis  = niveis_sr_ativos(df_m5, pivotos,
                                    lookback=self.sr_lookback,
                                    tolerancia=self.sr_tolerancia)

        close_atual     = float(df_m5['close'].iloc[-1])
        close_anterior  = float(df_m5['close'].iloc[-2])

        direcao_rompimento = rompimento_ocorreu(
            close_atual, close_anterior, niveis, self.sr_tolerancia
        )

        if direcao_rompimento == 'nenhum':
            resultado['motivo'] = "Sem rompimento de S/R confirmado"
            logger.debug(resultado['motivo'])
            return resultado

        # ── Filtro 5: Rompimento na direção do mercado ─────────────
        # Nunca comprar com RAFI > +2.50 num rompimento de suporte (sinal invertido)
        if direcao_rompimento != direcao_mercado:
            resultado['motivo'] = (
                f"Rompimento ({direcao_rompimento}) contra a tendência ({direcao_mercado})"
            )
            logger.warning(resultado['motivo'])
            return resultado

        # ── Filtro 6: Bollinger estreitas e abrindo ────────────────
        bb_abrindo = bollinger_estreitas_abrindo(
            bb,
            limiar_estreita=self.bb_estreita,
            abertura_minima=self.bb_abertura,
        )
        if not bool(bb_abrindo.iloc[-1]):
            resultado['motivo'] = (
                "Bollinger não está em abertura (bandas não estavam estreitas)"
            )
            logger.debug(resultado['motivo'])
            return resultado

        # ── Todas as condições satisfeitas ─────────────────────────
        # Determina nível S/R rompido para cálculo de stops
        nivel_rompido = _nivel_mais_proximo(
            close_atual, niveis, direcao_rompimento
        )

        resultado.update({
            'sinal'   : direcao_rompimento,
            'motivo'  : (
                f"Sinal VÁLIDO — direção: {direcao_rompimento} | "
                f"força: {forca_atual:.2f} | TFs: {sync['tendencias']} | "
                f"nível: {nivel_rompido}"
            ),
            'nivel_sr': nivel_rompido,
        })
        logger.info(resultado['motivo'])
        return resultado


# ─────────────────────────────────────────────────────────────
# REGRAS DE SAÍDA
# ─────────────────────────────────────────────────────────────

def calcular_stops(sinal: str,
                   preco_entrada: float,
                   nivel_sr: float,
                   ratio_rr: float = 1.5,
                   spread_pips: float = 0.8) -> dict:
    """
    Calcula stop-loss e take-profit baseados no nível S/R rompido.

    Para COMPRA:
      - Stop: abaixo do suporte/resistência rompida (nível SR)
      - TP  : entrada + (entrada - stop) * ratio_rr

    Para VENDA:
      - Stop: acima da resistência/suporte rompido
      - TP  : entrada - (stop - entrada) * ratio_rr

    O spread é descontado no cálculo do risco real.

    Retorna dict com: 'stop_loss', 'take_profit', 'risco_pips', 'tp_pips'
    """
    spread = spread_pips * 0.0001  # converter pips para preço

    if sinal == 'compra':
        stop_loss   = nivel_sr - spread              # abaixo do nível
        risco       = preco_entrada - stop_loss
        take_profit = preco_entrada + risco * ratio_rr
    else:  # venda
        stop_loss   = nivel_sr + spread              # acima do nível
        risco       = stop_loss - preco_entrada
        take_profit = preco_entrada - risco * ratio_rr

    risco_pips = round(risco / 0.0001, 1)
    tp_pips    = round(abs(take_profit - preco_entrada) / 0.0001, 1)

    return {
        'stop_loss'  : round(stop_loss,   5),
        'take_profit': round(take_profit, 5),
        'risco_pips' : risco_pips,
        'tp_pips'    : tp_pips,
    }


def verificar_saida(close_atual: float,
                    posicao: dict,
                    indice_forca: float,
                    forca_exaustao: float = -2.50) -> dict:
    """
    Verifica se a posição aberta deve ser fechada.

    Verifica em ordem:
      1. Stop-loss atingido
      2. Take-profit atingido
      3. Sinal de exaustão ("candle amarelo")

    Parâmetros:
      close_atual     : preço atual de fechamento
      posicao         : dict com 'sinal', 'stop_loss', 'take_profit',
                        'forca_anterior' (RAFI do candle anterior)
      indice_forca    : RAFI do candle atual
      forca_exaustao  : limiar de exaustão (padrão -2,50)

    Retorna dict com:
      'fechar': bool
      'motivo': str
    """
    sinal       = posicao['sinal']
    stop_loss   = posicao['stop_loss']
    take_profit = posicao['take_profit']
    forca_ant   = posicao.get('forca_anterior', 0.0)

    # ── Stop-loss ──────────────────────────────────────────────
    if sinal == 'compra' and close_atual <= stop_loss:
        return {'fechar': True, 'motivo': f"Stop-loss atingido @ {close_atual:.5f}"}
    if sinal == 'venda'  and close_atual >= stop_loss:
        return {'fechar': True, 'motivo': f"Stop-loss atingido @ {close_atual:.5f}"}

    # ── Take-profit ────────────────────────────────────────────
    if sinal == 'compra' and close_atual >= take_profit:
        return {'fechar': True, 'motivo': f"Take-profit atingido @ {close_atual:.5f}"}
    if sinal == 'venda'  and close_atual <= take_profit:
        return {'fechar': True, 'motivo': f"Take-profit atingido @ {close_atual:.5f}"}

    # ── Exaustão ("candle amarelo") ────────────────────────────
    if forca_ant > 2.50 and indice_forca < forca_exaustao:
        return {'fechar': True, 'motivo': "Exaustão detectada (candle amarelo)"}

    return {'fechar': False, 'motivo': ''}


# ─────────────────────────────────────────────────────────────
# FUNÇÕES AUXILIARES INTERNAS
# ─────────────────────────────────────────────────────────────

def _nivel_mais_proximo(close: float, niveis: dict, direcao: str) -> Optional[float]:
    """Retorna o nível S/R mais próximo do preço na direção do rompimento."""
    lista = niveis.get('resistencias' if direcao == 'compra' else 'suportes', [])
    if not lista:
        return None
    return min(lista, key=lambda n: abs(n - close))
