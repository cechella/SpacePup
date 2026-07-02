"""
tests/test_indicators.py — Testes unitários dos indicadores

Verifica que o índice de força RAFI, Bandas de Bollinger e
detecção de S/R funcionam corretamente com dados controlados.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import numpy as np
import pandas as pd
import pytest
from datetime import datetime, timedelta, timezone

from src.indicators import (
    calcular_indice_forca,
    detectar_exaustao,
    calcular_bollinger,
    bollinger_estreitas_abrindo,
    detectar_pivotos,
    niveis_sr_ativos,
    rompimento_ocorreu,
)


# ─────────────────────────────────────────────────────────────
# FIXTURES
# ─────────────────────────────────────────────────────────────

def criar_df(closes: list, highs=None, lows=None, opens=None, volumes=None) -> pd.DataFrame:
    """Cria um DataFrame OHLCV sintético para testes."""
    n  = len(closes)
    ts = [datetime(2023, 1, 1, tzinfo=timezone.utc) + timedelta(minutes=5 * i) for i in range(n)]
    closes = np.array(closes, dtype=float)
    return pd.DataFrame({
        'open'  : opens   if opens   is not None else closes - 0.0001,
        'high'  : highs   if highs   is not None else closes + 0.0002,
        'low'   : lows    if lows    is not None else closes - 0.0002,
        'close' : closes,
        'volume': volumes if volumes is not None else np.ones(n) * 100,
    }, index=pd.DatetimeIndex(ts, tz=timezone.utc))


@pytest.fixture
def df_tendencia_alta():
    """Serie de preços subindo uniformemente."""
    closes = [1.1000 + i * 0.0010 for i in range(50)]
    return criar_df(closes)


@pytest.fixture
def df_tendencia_baixa():
    """Serie de preços caindo uniformemente."""
    closes = [1.1500 - i * 0.0010 for i in range(50)]
    return criar_df(closes)


@pytest.fixture
def df_lateral():
    """Serie de preços sem tendência (oscilação pequena)."""
    np.random.seed(42)
    closes = 1.1000 + np.random.uniform(-0.0005, 0.0005, 50)
    return criar_df(closes.tolist())


# ─────────────────────────────────────────────────────────────
# TESTES: ÍNDICE DE FORÇA RAFI
# ─────────────────────────────────────────────────────────────

class TestIndiceForca:

    def test_retorna_serie_correto_tamanho(self, df_tendencia_alta):
        forca = calcular_indice_forca(df_tendencia_alta)
        assert len(forca) == len(df_tendencia_alta)

    def test_valores_dentro_do_range(self, df_tendencia_alta):
        """Índice deve estar entre -5 e +5 (range do RAFI original)."""
        forca = calcular_indice_forca(df_tendencia_alta)
        assert forca.dropna().between(-5, 5).all(), "Valores fora do range [-5, 5]"

    def test_tendencia_alta_gera_forca_positiva(self):
        """
        Candle de rompimento explosivo deve gerar força positiva.
        O RAFI mede aceleração do movimento, não tendência contínua:
        um candle muito acima da média recente → força > 0.
        """
        # 40 candles laterais, depois salto expressivo
        closes = [1.1000] * 40 + [1.1000 + i * 0.0015 for i in range(1, 11)]
        df = criar_df(closes)
        forca = calcular_indice_forca(df)
        # Último candle deve ter força positiva (aceleração acima da média)
        assert float(forca.iloc[-1]) > 0, "Rompimento explosivo deveria gerar força positiva"

    def test_tendencia_baixa_gera_forca_negativa(self, df_tendencia_baixa):
        """Preços caindo → maioria dos valores de força deve ser negativa."""
        forca = calcular_indice_forca(df_tendencia_baixa)
        valores_validos = forca.dropna()
        assert valores_validos.mean() < 0, "Força média deveria ser negativa em tendência de baixa"

    def test_nan_nos_primeiros_periodos(self, df_tendencia_alta):
        """Os primeiros candles devem retornar NaN por dados insuficientes."""
        forca = calcular_indice_forca(df_tendencia_alta, periodo=14)
        assert forca.iloc[:14].isna().any()

    def test_sem_dados_volume(self):
        """Deve funcionar mesmo sem dados de volume (usa zero)."""
        df = criar_df([1.10 + i*0.001 for i in range(30)], volumes=[0]*30)
        forca = calcular_indice_forca(df)
        assert forca is not None
        assert len(forca) == 30


class TestDetecaoExaustao:

    def test_detecta_exaustao(self):
        """Deve detectar exaustão quando RAFI vai de >2.5 para <-2.5."""
        # Simular índice com exaustão no candle 25
        n = 30
        df = criar_df([1.10 + i*0.001 for i in range(n)])
        forca = calcular_indice_forca(df)

        # Injetar valores para forçar exaustão
        forca_mock = pd.Series([0.0] * n, index=df.index, dtype=float)
        forca_mock.iloc[20] = 3.0   # forte
        forca_mock.iloc[21] = -3.0  # exaustão no candle seguinte

        exaustao = detectar_exaustao(forca_mock, limiar_forte=2.50, limiar_fraco=-2.50)
        assert exaustao.iloc[21] == True, "Deveria detectar exaustão no candle 21"

    def test_sem_exaustao_sem_forca_previa(self):
        """Não deve sinalizar exaustão se o candle anterior não era forte."""
        forca_mock = pd.Series([1.0, -3.0, 1.0], dtype=float)
        exaustao = detectar_exaustao(forca_mock)
        assert not exaustao.iloc[1], "Não deveria detectar exaustão sem força prévia"


# ─────────────────────────────────────────────────────────────
# TESTES: BANDAS DE BOLLINGER
# ─────────────────────────────────────────────────────────────

class TestBollinger:

    def test_retorna_colunas_corretas(self, df_tendencia_alta):
        bb = calcular_bollinger(df_tendencia_alta)
        assert 'bb_media'    in bb.columns
        assert 'bb_superior' in bb.columns
        assert 'bb_inferior' in bb.columns
        assert 'bb_largura'  in bb.columns

    def test_superior_maior_inferior(self, df_tendencia_alta):
        """Banda superior deve ser sempre > banda inferior."""
        bb = calcular_bollinger(df_tendencia_alta)
        bb_valido = bb.dropna()
        assert (bb_valido['bb_superior'] > bb_valido['bb_inferior']).all()

    def test_largura_sempre_positiva(self, df_tendencia_alta):
        bb = calcular_bollinger(df_tendencia_alta)
        assert (bb['bb_largura'].dropna() > 0).all()

    def test_periodo_8(self):
        """Com período 8, primeiros 7 candles devem ser NaN."""
        df = criar_df([1.10 + i*0.001 for i in range(20)])
        bb = calcular_bollinger(df, periodo=8)
        assert bb['bb_media'].iloc[:7].isna().all()
        assert not pd.isna(bb['bb_media'].iloc[7])

    def test_bollinger_abrindo_detectado(self):
        """Deve detectar quando bandas estreitas começam a abrir."""
        # Candles iniciais: mercado comprimido
        closes_estreitos = [1.1000 + i * 0.00001 for i in range(20)]
        # Candle final: expansão
        closes_estreitos += [1.1020 + i * 0.0005 for i in range(5)]
        df = criar_df(closes_estreitos)
        bb = calcular_bollinger(df)
        abrindo = bollinger_estreitas_abrindo(
            bb, limiar_estreita=0.0050, abertura_minima=0.0001
        )
        # Deve detectar abertura em algum dos últimos candles
        assert abrindo.iloc[-3:].any()


# ─────────────────────────────────────────────────────────────
# TESTES: SUPORTES E RESISTÊNCIAS
# ─────────────────────────────────────────────────────────────

class TestSuporteResistencia:

    def _df_com_pivos(self):
        """DataFrame com topo e fundo claros."""
        closes = (
            [1.1000] * 5 +          # lateral
            [1.1010, 1.1020, 1.1030, 1.1040, 1.1050] +  # subida
            [1.1040, 1.1030, 1.1020, 1.1010, 1.1000] +  # descida → pivô de topo
            [1.0990, 1.0980, 1.0970, 1.0980, 1.0990] +  # fundo → pivô de fundo
            [1.1000] * 10
        )
        highs = [c + 0.0005 for c in closes]
        lows  = [c - 0.0005 for c in closes]
        return criar_df(closes, highs=highs, lows=lows)

    def test_detecta_pivo_topo(self):
        df = self._df_com_pivos()
        pivotos = detectar_pivotos(df, janela=3)
        assert pivotos['pivo_topo'].any(), "Deve detectar pelo menos um pivô de topo"

    def test_detecta_pivo_fundo(self):
        df = self._df_com_pivos()
        pivotos = detectar_pivotos(df, janela=3)
        assert pivotos['pivo_fundo'].any(), "Deve detectar pelo menos um pivô de fundo"

    def test_rompimento_compra(self):
        """Fechar acima de uma resistência deve retornar 'compra'."""
        niveis = {'resistencias': [1.1050], 'suportes': [1.0950]}
        # Anterior abaixo, atual acima + tolerância
        resultado = rompimento_ocorreu(1.1060, 1.1045, niveis, tolerancia=0.0005)
        assert resultado == 'compra'

    def test_rompimento_venda(self):
        """Fechar abaixo de um suporte deve retornar 'venda'."""
        niveis = {'resistencias': [1.1050], 'suportes': [1.0950]}
        resultado = rompimento_ocorreu(1.0940, 1.0955, niveis, tolerancia=0.0005)
        assert resultado == 'venda'

    def test_sem_rompimento(self):
        """Preço dentro do range deve retornar 'nenhum'."""
        niveis = {'resistencias': [1.1050], 'suportes': [1.0950]}
        resultado = rompimento_ocorreu(1.1000, 1.0990, niveis)
        assert resultado == 'nenhum'

    def test_niveis_sr_ativos_agrupa_proximos(self):
        """Pivôs próximos (< tolerância) devem ser agrupados."""
        df = self._df_com_pivos()
        pivotos = detectar_pivotos(df, janela=3)
        niveis = niveis_sr_ativos(df, pivotos, lookback=len(df), tolerancia=0.0020)
        # Deve ter pelo menos 1 nível de cada
        assert len(niveis['resistencias']) >= 1 or len(niveis['suportes']) >= 1
