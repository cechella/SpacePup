"""
strategy.py — Regras de entrada, saída e filtros da estratégia RAFI

Filtros em ordem (conforme fluxo definido pelo trader):
  1. Horário dentro de sessão ativa? (07–08h ou 12–16h GMT)
  2. M5 + M15 apontam a mesma direção?
  3. Preço rompeu S/R relevante?
  4. Índice de força RAFI > 2.50 no candle do rompimento?
  → SINAL VÁLIDO: calcular lote, enviar ordem com SL e TP
  → Monitorar candle amarelo (exaustão) → fechar posição
"""

import logging
import pandas as pd
from datetime import datetime
from typing import Optional

from .indicators import (
    calcular_indice_forca,
    detectar_pivotos,
    niveis_sr_ativos,
    rompimento_ocorreu,
)
from .multi_timeframe import verificar_sincronismo

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────
# SESSÕES DE TRADING (sobreposições GMT)
# ─────────────────────────────────────────────────────────────

# Somente as duas sobreposições com melhor liquidez no EURUSD
SESSOES_UTC = {
    'toquio_londres': (7,  0,  8,  0),   # 07:00–08:00 GMT
    'londres_ny'    : (12, 0,  16, 0),   # 12:00–16:00 GMT
}


def em_sessao_ativa(dt: datetime) -> bool:
    """
    Verifica se o datetime (UTC) está dentro de uma janela de sessão ativa.

    Retorna True apenas para 07:00–08:00 ou 12:00–16:00 GMT.
    """
    minutos = dt.hour * 60 + dt.minute
    for _, (h_ini, m_ini, h_fim, m_fim) in SESSOES_UTC.items():
        ini = h_ini * 60 + m_ini
        fim = h_fim * 60 + m_fim
        if ini <= minutos < fim:
            return True
    return False


# ─────────────────────────────────────────────────────────────
# ANÁLISE DE SINAL
# ─────────────────────────────────────────────────────────────

class AnalisadorSinal:
    """
    Analisa candles M5 + M15 e decide se há sinal de entrada.

    Filtros aplicados na ordem exata definida pelo trader:
      1. Sessão  2. M5+M15 alinhados  3. S/R rompido  4. RAFI > 2.50
    """

    def __init__(self, config: dict):
        self.forca_limiar  = float(config.get('forca_limiar', 2.50))
        self.forca_exaust  = float(config.get('forca_exaustao', -2.50))
        self.sr_lookback   = int(config.get('sr_lookback', 50))
        self.sr_tolerancia = float(config.get('sr_tolerancia', 0.0005))
        self.ma_rapida     = int(config.get('ma_rapida', 20))
        self.ma_lenta      = int(config.get('ma_lenta', 50))

    def analisar(self,
                 df_m5: pd.DataFrame,
                 df_m15: pd.DataFrame,
                 timestamp: Optional[datetime] = None) -> dict:
        """
        Executa a análise completa e retorna um dict de sinal.

        Parâmetros:
          df_m5     : DataFrame M5 com colunas [open, high, low, close, volume]
          df_m15    : DataFrame M15
          timestamp : datetime UTC do candle atual

        Retorna dict com:
          'sinal'   : 'compra' | 'venda' | 'nenhum'
          'motivo'  : str explicando a decisão
          'forca'   : float — índice de força no candle atual
          'close'   : float — preço de fechamento atual
          'nivel_sr': float — nível S/R rompido (ou None)
        """
        if timestamp is None:
            idx = df_m5.index[-1]
            timestamp = idx if isinstance(idx, datetime) else datetime.utcnow()

        resultado = {
            'sinal'   : 'nenhum',
            'motivo'  : '',
            'forca'   : None,
            'close'   : float(df_m5['close'].iloc[-1]),
            'nivel_sr': None,
            'timestamp': timestamp,
        }

        # ── Filtro 1: Sessão ativa ────────────────────────────────
        if not em_sessao_ativa(timestamp):
            resultado['motivo'] = f"Fora de sessão ({timestamp.strftime('%H:%M')} UTC)"
            logger.debug(resultado['motivo'])
            return resultado

        # ── Filtro 2: M5 + M15 na mesma direção ──────────────────
        dfs = {'M5': df_m5, 'M15': df_m15}
        sync = verificar_sincronismo(dfs, self.ma_rapida, self.ma_lenta)
        if not sync['sincronizado']:
            resultado['motivo'] = f"M5/M15 não sincronizados: {sync['tendencias']}"
            logger.debug(resultado['motivo'])
            return resultado

        direcao_mercado = sync['direcao']  # 'compra' ou 'venda'

        # ── Filtro 3: Rompimento de S/R ───────────────────────────
        pivotos = detectar_pivotos(df_m5, janela=5)
        niveis  = niveis_sr_ativos(df_m5, pivotos,
                                    lookback=self.sr_lookback,
                                    tolerancia=self.sr_tolerancia)

        close_atual    = float(df_m5['close'].iloc[-1])
        close_anterior = float(df_m5['close'].iloc[-2])
        direcao_romp   = rompimento_ocorreu(close_atual, close_anterior,
                                             niveis, self.sr_tolerancia)

        if direcao_romp == 'nenhum':
            resultado['motivo'] = "Sem rompimento de S/R confirmado"
            logger.debug(resultado['motivo'])
            return resultado

        # Nunca comprar rompendo suporte, nunca vender rompendo resistência
        if direcao_romp != direcao_mercado:
            resultado['motivo'] = (
                f"Rompimento ({direcao_romp}) contra a tendência ({direcao_mercado})"
            )
            logger.warning(resultado['motivo'])
            return resultado

        # ── Filtro 4: Força RAFI > 2.50 ──────────────────────────
        forca_serie = calcular_indice_forca(df_m5)
        forca_atual = float(forca_serie.iloc[-1])
        resultado['forca'] = forca_atual

        if forca_atual < self.forca_limiar:
            resultado['motivo'] = (
                f"Força insuficiente no rompimento: {forca_atual:.2f} < {self.forca_limiar}"
            )
            logger.debug(resultado['motivo'])
            return resultado

        # ── Sinal válido ──────────────────────────────────────────
        nivel_rompido = _nivel_mais_proximo(close_atual, niveis, direcao_romp)

        resultado.update({
            'sinal'   : direcao_romp,
            'motivo'  : (
                f"Sinal VALIDO | {direcao_romp.upper()} | "
                f"forca={forca_atual:.2f} | TFs={sync['tendencias']} | "
                f"S/R={nivel_rompido}"
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
                   nivel_stop: float,
                   ratio_rr: float = 1.5,
                   spread_pips: float = 0.8) -> dict:
    """
    Calcula stop-loss e take-profit baseados no swing low/high de mercado.

    COMPRA: stop abaixo do swing low recente (fundo dos últimos N candles M5)
    VENDA : stop acima do swing high recente (topo dos últimos N candles M5)

    Esta abordagem coloca o stop na estrutura real do mercado — se o preço
    volta abaixo do fundo mais recente, o movimento foi invalidado.
    Risco em USD = risco_pips × lote × $10/pip (exibido no log de abertura).

    Retorna dict com: 'stop_loss', 'take_profit', 'risco_pips', 'tp_pips'
    """
    spread = spread_pips * 0.0001

    if sinal == 'compra':
        stop_loss   = nivel_stop - spread   # just below swing low
        risco       = preco_entrada - stop_loss
        take_profit = preco_entrada + risco * ratio_rr
    else:
        stop_loss   = nivel_stop + spread   # just above swing high
        risco       = stop_loss - preco_entrada
        take_profit = preco_entrada - risco * ratio_rr

    return {
        'stop_loss'  : round(stop_loss,   5),
        'take_profit': round(take_profit, 5),
        'risco_pips' : round(risco / 0.0001, 1),
        'tp_pips'    : round(abs(take_profit - preco_entrada) / 0.0001, 1),
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
      3. Candle amarelo (exaustão): RAFI anterior > 2.50 → atual < -2.50

    Retorna dict com: 'fechar' (bool), 'motivo' (str)
    """
    sinal       = posicao['sinal']
    stop_loss   = posicao['stop_loss']
    take_profit = posicao['take_profit']
    forca_ant   = posicao.get('forca_anterior', 0.0)

    if sinal == 'compra' and close_atual <= stop_loss:
        return {'fechar': True, 'motivo': f"Stop-loss atingido @ {close_atual:.5f}"}
    if sinal == 'venda'  and close_atual >= stop_loss:
        return {'fechar': True, 'motivo': f"Stop-loss atingido @ {close_atual:.5f}"}

    if sinal == 'compra' and close_atual >= take_profit:
        return {'fechar': True, 'motivo': f"Take-profit atingido @ {close_atual:.5f}"}
    if sinal == 'venda'  and close_atual <= take_profit:
        return {'fechar': True, 'motivo': f"Take-profit atingido @ {close_atual:.5f}"}

    # Candle amarelo: RAFI era super forte (> 2.50), agora está fraco (< forca_exaustao)
    # RAFI é sempre positivo — exaustão = força colapsou, movimento perdeu participantes
    # forca_exaustao em config deve ser positivo e baixo (ex: 0.80)
    if forca_ant > 2.50 and indice_forca < forca_exaustao:
        return {'fechar': True, 'motivo': "Exaustão detectada (candle amarelo)"}

    return {'fechar': False, 'motivo': ''}


# ─────────────────────────────────────────────────────────────
# AUXILIAR INTERNO
# ─────────────────────────────────────────────────────────────

def _nivel_mais_proximo(close: float, niveis: dict, direcao: str) -> Optional[float]:
    """Retorna o nível S/R mais próximo do preço na direção do rompimento."""
    lista = niveis.get('resistencias' if direcao == 'compra' else 'suportes', [])
    if not lista:
        return None
    return min(lista, key=lambda n: abs(n - close))
