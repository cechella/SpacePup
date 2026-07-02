"""
tests/test_risk_manager.py — Testes do gestor de risco

Verifica regras INEGOCIÁVEIS:
  - Stop após 1 perda por dia
  - Limite de trades simultâneos
  - Dimensionamento correto do lote
  - Perda diária máxima
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from src.risk_manager import GestorRisco


def config_padrao() -> dict:
    return {
        'risco_por_trade'    : 0.02,
        'risco_maximo_diario': 0.05,
        'max_trades_simultaneos': 2,
        'max_perdas_por_dia' : 1,
        'alavancagem'        : 1000,
        'spread_pips'        : 0.8,
        'slippage_pips'      : 0.5,
        'tamanho_lote_minimo': 0.01,
        'ratio_risco_retorno': 1.5,
        'par'                : 'EURUSD',
    }


class TestGestorRisco:

    def test_pode_operar_inicial(self):
        """Deve poder operar no início do dia."""
        gr = GestorRisco(config_padrao())
        pode, motivo = gr.pode_operar(capital_atual=100.0)
        assert pode is True
        assert motivo == ''

    def test_parar_apos_uma_perda(self):
        """Após 1 perda, o bot deve parar (max_perdas_por_dia=1)."""
        gr = GestorRisco(config_padrao())
        gr.abrir_trade()
        gr.fechar_trade(resultado_usd=-2.0, capital_atual=98.0)
        pode, motivo = gr.pode_operar(capital_atual=98.0)
        assert pode is False
        assert 'perda' in motivo.lower() or 'limite' in motivo.lower()

    def test_nao_ultrapassa_limite_simultaneo(self):
        """Após 2 trades abertos, deve bloquear novo trade."""
        gr = GestorRisco(config_padrao())
        gr.abrir_trade()
        gr.abrir_trade()
        pode, motivo = gr.pode_operar(capital_atual=100.0)
        assert pode is False
        assert 'simultâneo' in motivo.lower() or 'limite' in motivo.lower()

    def test_calculo_lote_basico(self):
        """Com $100 capital e 20 pips de risco, lote deve ser calculado corretamente."""
        gr = GestorRisco(config_padrao())
        # Risco por trade = 2% de $100 = $2
        # risco total pips = 20 + 0.8 + 0.5 = 21.3 pips
        # lote = 2 / (21.3 * 10) = 0.0094 → arredonda para 0.01 (mínimo)
        lote = gr.calcular_lote(capital_atual=100.0, risco_pips=20.0)
        assert lote >= 0.01
        assert lote <= 0.10  # não deve ser absurdamente grande

    def test_lote_minimo_respeitado(self):
        """Mesmo com capital muito baixo, o lote mínimo é 0.01."""
        gr = GestorRisco(config_padrao())
        lote = gr.calcular_lote(capital_atual=5.0, risco_pips=50.0)
        assert lote >= 0.01

    def test_lote_proporcional_ao_capital(self):
        """Lote com $200 deve ser aprox. o dobro que com $100."""
        gr = GestorRisco(config_padrao())
        lote_100 = gr.calcular_lote(capital_atual=100.0, risco_pips=20.0)
        lote_200 = gr.calcular_lote(capital_atual=200.0, risco_pips=20.0)
        assert lote_200 > lote_100

    def test_perda_diaria_percentual(self):
        """Perda acumulada ≥ 5% do capital deve parar o bot."""
        gr = GestorRisco(config_padrao())
        # Registrar perda de 6% do capital
        gr.abrir_trade()
        gr.fechar_trade(resultado_usd=-6.0, capital_atual=94.0)
        # Reset contador de perdas por dia para testar só o limite %
        gr._perdas_dia = 0  # reset artificial para testar só limite %
        gr._parado_hoje = False  # será reavaliado
        pode, motivo = gr.pode_operar(capital_atual=94.0)
        # Perda acumulada ($6) / capital ($94) ≈ 6.4% > 5%
        assert pode is False

    def test_status_retorna_dict(self):
        """Status deve retornar um dict com os campos esperados."""
        gr = GestorRisco(config_padrao())
        status = gr.status(100.0)
        assert 'pode_operar'    in status
        assert 'trades_abertos' in status
        assert 'perdas_hoje'    in status
        assert 'parado_hoje'    in status

    def test_fechar_trade_decrementa_abertos(self):
        """Fechar um trade deve decrementar o contador de trades abertos."""
        gr = GestorRisco(config_padrao())
        gr.abrir_trade()
        assert gr._trades_abertos == 1
        gr.fechar_trade(resultado_usd=5.0, capital_atual=105.0)
        assert gr._trades_abertos == 0

    def test_lote_invalido_risco_zero(self):
        """Risco zero deve retornar lote mínimo sem crash."""
        gr = GestorRisco(config_padrao())
        lote = gr.calcular_lote(capital_atual=100.0, risco_pips=0)
        assert lote == 0.01  # lote mínimo
