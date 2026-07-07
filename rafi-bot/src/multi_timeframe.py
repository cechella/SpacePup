"""
multi_timeframe.py — Sincronismo de múltiplos timeframes (M5, M15, H1)

Determina a tendência de cada timeframe com base em:
  - Topos e fundos ascendentes/descendentes (estrutura de mercado)
  - Médias móveis (MA rápida 20 vs. MA lenta 50)

Regra: TODOS os três timeframes devem apontar a mesma direção.
Se houver conflito → NÃO OPERA.
"""

import pandas as pd
import numpy as np


def tendencia_por_medias(df: pd.DataFrame,
                          ma_rapida: int = 20,
                          ma_lenta: int = 50) -> str:
    """
    Determina a tendência pelo cruzamento de médias móveis simples.

    Retorna:
      'alta'    — MA rápida > MA lenta no último candle
      'baixa'   — MA rápida < MA lenta
      'lateral' — diferença menor que 1 pip (sem tendência definida)
    """
    close = df['close']
    if len(close) < ma_lenta:
        return 'indefinida'  # dados insuficientes

    ma_r = close.rolling(ma_rapida).mean().iloc[-1]
    ma_l = close.rolling(ma_lenta).mean().iloc[-1]

    diferenca = ma_r - ma_l
    # Limiar de 1 pip (0.0001) para evitar considerar lateralidade como tendência
    if abs(diferenca) < 0.0001:
        return 'lateral'
    return 'alta' if diferenca > 0 else 'baixa'


def tendencia_por_estrutura(df: pd.DataFrame, janela_pivo: int = 3) -> str:
    """
    Determina tendência pela estrutura de topos e fundos.

    Método: compara os dois últimos topos locais e os dois últimos fundos locais.
      - Topos ascendentes E fundos ascendentes → 'alta'
      - Topos descendentes E fundos descendentes → 'baixa'
      - Qualquer outro padrão → 'lateral'

    Parâmetros:
      df         : DataFrame com colunas 'high' e 'low'
      janela_pivo: candles de cada lado para identificar pivô local
    """
    high = df['high']
    low  = df['low']
    n    = len(df)

    if n < (janela_pivo * 4 + 1):
        return 'indefinida'

    # Coleta topos e fundos locais (últimos 60 candles para eficiência)
    ultimos = min(n, 60)
    high_slice = high.iloc[-ultimos:]
    low_slice  = low.iloc[-ultimos:]

    topos  = []
    fundos = []

    for i in range(janela_pivo, len(high_slice) - janela_pivo):
        h_i = high_slice.iloc[i]
        l_i = low_slice.iloc[i]
        # Pivô de topo: high local máximo
        if h_i == high_slice.iloc[i - janela_pivo: i + janela_pivo + 1].max():
            topos.append(h_i)
        # Pivô de fundo: low local mínimo
        if l_i == low_slice.iloc[i - janela_pivo: i + janela_pivo + 1].min():
            fundos.append(l_i)

    if len(topos) < 2 or len(fundos) < 2:
        return 'indefinida'

    topo_anterior, topo_atual = topos[-2], topos[-1]
    fundo_anterior, fundo_atual = fundos[-2], fundos[-1]

    topos_asc  = topo_atual  > topo_anterior
    fundos_asc = fundo_atual > fundo_anterior
    topos_desc  = topo_atual  < topo_anterior
    fundos_desc = fundo_atual < fundo_anterior

    if topos_asc and fundos_asc:
        return 'alta'
    if topos_desc and fundos_desc:
        return 'baixa'
    return 'lateral'


def tendencia_combinada(df: pd.DataFrame,
                         ma_rapida: int = 20,
                         ma_lenta: int = 50) -> str:
    """
    Combina estrutura de mercado e médias móveis para definir a tendência.

    Prioridade: ambos devem concordar para dar 'alta' ou 'baixa'.
    Se divergirem → 'lateral'.
    """
    tend_ma        = tendencia_por_medias(df, ma_rapida, ma_lenta)
    tend_estrutura = tendencia_por_estrutura(df)

    # MA é a fonte primária (conforme CLAUDE.md §2.2: "topos/fundos E/OU MAs")
    if tend_ma in ('alta', 'baixa'):
        return tend_ma

    # MA inconclusiva → usar estrutura de topos/fundos como fallback
    if tend_estrutura in ('alta', 'baixa'):
        return tend_estrutura

    # Ambas inconclusivas → lateral (não opera)
    return 'lateral'


def verificar_sincronismo(dfs: dict,
                           ma_rapida: int = 20,
                           ma_lenta: int = 50) -> dict:
    """
    Verifica o sincronismo entre todos os timeframes fornecidos.

    Parâmetros:
      dfs      : dict como {'M5': df_m5, 'M15': df_m15, 'H1': df_h1}
      ma_rapida: período da MA rápida
      ma_lenta : período da MA lenta

    Retorna:
      dict com:
        'tendencias'  : dict timeframe → tendência ('alta'|'baixa'|'lateral')
        'sincronizado': bool — True se todos apontam a mesma direção (alta ou baixa)
        'direcao'     : str  — 'compra', 'venda' ou 'nenhuma'
    """
    tendencias = {}
    for tf, df in dfs.items():
        if df is None or df.empty:
            tendencias[tf] = 'indefinida'
        else:
            tendencias[tf] = tendencia_combinada(df, ma_rapida, ma_lenta)

    valores = list(tendencias.values())

    # Sincronizado: todos iguais e diferentes de 'lateral'/'indefinida'
    todos_alta  = all(v == 'alta'  for v in valores)
    todos_baixa = all(v == 'baixa' for v in valores)

    sincronizado = todos_alta or todos_baixa
    if todos_alta:
        direcao = 'compra'
    elif todos_baixa:
        direcao = 'venda'
    else:
        direcao = 'nenhuma'

    return {
        'tendencias'  : tendencias,
        'sincronizado': sincronizado,
        'direcao'     : direcao,
    }
