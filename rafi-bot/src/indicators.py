"""
indicators.py — Indicadores técnicos do Bot RAFI

Contém:
  - Índice de Força RAFI (aproximação do indicador proprietário)
  - Bandas de Bollinger (8 períodos, 2 desvios padrão)
  - Detecção de Suportes e Resistências por pivôs
"""

import numpy as np
import pandas as pd


# ─────────────────────────────────────────────────────────────
# ÍNDICE DE FORÇA RAFI (aproximação)
# ─────────────────────────────────────────────────────────────

def calcular_indice_forca(df: pd.DataFrame, periodo: int = 14) -> pd.Series:
    """
    Calcula o Índice de Força RAFI — aproximação do indicador proprietário.

    A fórmula combina três componentes normalizados:
      1. Momentum normalizado: variação do fechamento em relação à média do período
      2. Amplitude do candle vs. média: força do corpo do candle atual
      3. Volume relativo: volume atual vs. média do período

    Leitura equivalente ao RAFI original:
      > +2,50  → super forte (sinal de entrada válido)
       0..+2,49 → forte
      -2,49..0 → fraco
      < -2,50  → super fraco (possível exaustão)

    Parâmetros:
      df      : DataFrame com colunas ['open', 'high', 'low', 'close', 'volume']
      periodo : janela de lookback para normalização (padrão 14)

    Retorna:
      pd.Series com o índice de força para cada candle
    """
    close = df['close']
    high  = df['high']
    low   = df['low']
    open_ = df['open']

    # --- Componente 1: Momentum normalizado ---
    # Variação percentual do fechamento multiplicada por fator de escala
    retorno = close.pct_change(1)
    retorno_medio = retorno.rolling(periodo).mean()
    retorno_std   = retorno.rolling(periodo).std().replace(0, np.nan)
    momentum_norm = (retorno - retorno_medio) / retorno_std  # z-score

    # --- Componente 2: Amplitude do candle vs. média ---
    # Corpo real do candle (fechamento - abertura) em proporção ao range médio
    corpo = close - open_
    range_candle = (high - low).replace(0, np.nan)
    range_medio  = range_candle.rolling(periodo).mean().replace(0, np.nan)
    amplitude_norm = corpo / range_medio

    # --- Componente 3: Volume relativo ---
    # Volume atual em relação ao volume médio; bots sem volume usam 1.0
    if 'volume' in df.columns and df['volume'].sum() > 0:
        volume = df['volume'].replace(0, np.nan)
        vol_medio = volume.rolling(periodo).mean().replace(0, np.nan)
        volume_rel = (volume / vol_medio - 1.0)  # 0 = volume na média
    else:
        # Sem dados de volume: componente neutro
        volume_rel = pd.Series(0.0, index=df.index)

    # --- Composição final (pesos calibrados para escala RAFI original) ---
    # Pesos: momentum tem maior peso, amplitude e volume são complementares
    indice = (1.5 * momentum_norm + 1.0 * amplitude_norm + 0.5 * volume_rel)

    # Limitar ao range de leitura do RAFI original (aprox. -5 a +5)
    indice = indice.clip(-5.0, 5.0)

    return indice.rename("indice_forca")


def detectar_exaustao(indice_forca: pd.Series,
                       limiar_forte: float = 2.50,
                       limiar_fraco: float = -2.50) -> pd.Series:
    """
    Detecta o "candle amarelo" (exaustão): RAFI > +2,50 seguido de RAFI < -2,50
    no candle imediatamente seguinte.

    Retorna:
      pd.Series booleana — True onde há sinal de exaustão
    """
    forte_anterior = indice_forca.shift(1) > limiar_forte
    fraco_atual    = indice_forca < limiar_fraco
    return (forte_anterior & fraco_atual).rename("exaustao")


# ─────────────────────────────────────────────────────────────
# BANDAS DE BOLLINGER
# ─────────────────────────────────────────────────────────────

def calcular_bollinger(df: pd.DataFrame,
                        periodo: int = 8,
                        desvios: float = 2.0) -> pd.DataFrame:
    """
    Calcula as Bandas de Bollinger.

    Parâmetros:
      df      : DataFrame com coluna 'close'
      periodo : janela da média móvel (padrão 8, conforme estratégia RAFI)
      desvios : número de desvios padrão (padrão 2)

    Retorna:
      DataFrame com colunas: bb_media, bb_superior, bb_inferior, bb_largura
    """
    close = df['close']
    media    = close.rolling(periodo).mean()
    std      = close.rolling(periodo).std()
    superior = media + desvios * std
    inferior = media - desvios * std
    largura  = superior - inferior  # largura absoluta das bandas

    resultado = pd.DataFrame({
        'bb_media'   : media,
        'bb_superior': superior,
        'bb_inferior': inferior,
        'bb_largura' : largura,
    }, index=df.index)

    return resultado


def bollinger_estreitas_abrindo(bb: pd.DataFrame,
                                 limiar_estreita: float = 0.0010,
                                 abertura_minima: float = 0.0003,
                                 lookback: int = 3) -> pd.Series:
    """
    Verifica se as Bandas de Bollinger estavam estreitas e estão se abrindo —
    sinal de timing de entrada conforme estratégia RAFI.

    Critério:
      1. A largura mínima dos últimos `lookback` candles era ≤ limiar_estreita
      2. A largura atual é > (mínimo recente + abertura_minima)

    Retorna:
      pd.Series booleana — True quando as bandas satisfazem o critério
    """
    largura = bb['bb_largura']
    min_recente = largura.shift(1).rolling(lookback).min()
    estava_estreita = min_recente <= limiar_estreita
    esta_abrindo    = largura > (min_recente + abertura_minima)
    return (estava_estreita & esta_abrindo).rename("bb_abrindo")


# ─────────────────────────────────────────────────────────────
# SUPORTES E RESISTÊNCIAS (PIVÔS)
# ─────────────────────────────────────────────────────────────

def detectar_pivotos(df: pd.DataFrame, janela: int = 5) -> pd.DataFrame:
    """
    Identifica pivôs de topo (resistência) e fundo (suporte) locais.

    Um pivô de topo ocorre quando o high atual é o máximo dos últimos e
    próximos `janela` candles. Pivô de fundo: low é o mínimo.

    Parâmetros:
      df     : DataFrame com colunas 'high' e 'low'
      janela : número de candles para cada lado do pivô

    Retorna:
      DataFrame com colunas: 'pivo_topo' (bool), 'pivo_fundo' (bool)
    """
    high = df['high']
    low  = df['low']

    # Máximo e mínimo em janela centrada (evita lookahead — verificado só no fechamento)
    max_janela = high.rolling(2 * janela + 1, center=True).max()
    min_janela = low.rolling(2 * janela + 1, center=True).min()

    pivo_topo  = (high == max_janela)
    pivo_fundo = (low  == min_janela)

    return pd.DataFrame({
        'pivo_topo' : pivo_topo,
        'pivo_fundo': pivo_fundo,
    }, index=df.index)


def niveis_sr_ativos(df: pd.DataFrame,
                      pivotos: pd.DataFrame,
                      lookback: int = 50,
                      tolerancia: float = 0.0005) -> dict:
    """
    Retorna os níveis de S/R mais recentes e ainda "ativos" (não rompidos).

    Agrupa pivôs próximos (dentro da tolerância) em zonas únicas.

    Parâmetros:
      df         : DataFrame com coluna 'close'
      pivotos    : saída de detectar_pivotos()
      lookback   : quantos candles para trás considerar
      tolerancia : distância máxima em preço para agrupar pivôs na mesma zona

    Retorna:
      dict com:
        'resistencias': list[float] — preços de resistência (topo)
        'suportes'    : list[float] — preços de suporte (fundo)
    """
    janela_df = df.iloc[-lookback:]
    jan_piv   = pivotos.iloc[-lookback:]

    # Coletar preços de pivôs
    resistencias_raw = janela_df.loc[jan_piv['pivo_topo'],  'high'].tolist()
    suportes_raw     = janela_df.loc[jan_piv['pivo_fundo'], 'low'].tolist()

    def agrupar_niveis(niveis: list, tol: float) -> list:
        """Agrupa preços próximos em um único nível (média do cluster)."""
        if not niveis:
            return []
        niveis_ord = sorted(niveis)
        clusters   = [[niveis_ord[0]]]
        for preco in niveis_ord[1:]:
            if preco - clusters[-1][-1] <= tol:
                clusters[-1].append(preco)
            else:
                clusters.append([preco])
        return [round(np.mean(c), 5) for c in clusters]

    return {
        'resistencias': agrupar_niveis(resistencias_raw, tolerancia),
        'suportes'    : agrupar_niveis(suportes_raw,     tolerancia),
    }


def rompimento_ocorreu(close_atual: float,
                        close_anterior: float,
                        niveis: dict,
                        tolerancia: float = 0.0005) -> str:
    """
    Verifica se o preço rompeu um nível de S/R.

    Retorna:
      'compra'  — fechamento acima de uma resistência
      'venda'   — fechamento abaixo de um suporte
      'nenhum'  — sem rompimento
    """
    for resistencia in niveis.get('resistencias', []):
        # Fechamento anterior abaixo da resistência + fechamento atual acima
        if close_anterior < resistencia and close_atual > resistencia + tolerancia:
            return 'compra'

    for suporte in niveis.get('suportes', []):
        if close_anterior > suporte and close_atual < suporte - tolerancia:
            return 'venda'

    return 'nenhum'
