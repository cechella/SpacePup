"""
tests/test_strategy.py — Testes das regras de estratégia RAFI

Verifica os filtros de sessão, stops e verificação de saída.
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest
from datetime import datetime, timezone

from src.strategy import (
    em_sessao_ativa,
    calcular_stops,
    verificar_saida,
)


# ─────────────────────────────────────────────────────────────
# TESTES: SESSÕES DE TRADING
# ─────────────────────────────────────────────────────────────

class TestSessoes:

    def _dt(self, hora: int, minuto: int = 0) -> datetime:
        return datetime(2023, 1, 2, hora, minuto, tzinfo=timezone.utc)

    def test_sessao_londres_ny_ativa(self):
        """12:00–16:00 UTC deve estar ativo."""
        assert em_sessao_ativa(self._dt(12, 0))
        assert em_sessao_ativa(self._dt(14, 30))
        assert em_sessao_ativa(self._dt(15, 59))

    def test_sessao_londres_ny_inativa_apos_16(self):
        """16:00 UTC em diante deve estar inativo."""
        assert not em_sessao_ativa(self._dt(16, 0))
        assert not em_sessao_ativa(self._dt(17, 0))

    def test_sessao_toquio_londres_ativa(self):
        """07:00–08:00 UTC deve estar ativo."""
        assert em_sessao_ativa(self._dt(7, 0))
        assert em_sessao_ativa(self._dt(7, 30))

    def test_sessao_toquio_londres_inativa_apos_8(self):
        assert not em_sessao_ativa(self._dt(8, 0))
        assert not em_sessao_ativa(self._dt(9, 0))

    def test_fora_de_todas_sessoes(self):
        """09:00, 18:00, 20:00, 23:00 devem estar inativos (Tokyo+Sydney removida)."""
        assert not em_sessao_ativa(self._dt(9, 0))
        assert not em_sessao_ativa(self._dt(18, 0))
        assert not em_sessao_ativa(self._dt(20, 0))
        assert not em_sessao_ativa(self._dt(5, 0))
        assert not em_sessao_ativa(self._dt(23, 0))
        assert not em_sessao_ativa(self._dt(0, 30))


# ─────────────────────────────────────────────────────────────
# TESTES: CÁLCULO DE STOPS
# ─────────────────────────────────────────────────────────────

class TestCalculaStops:

    def test_compra_stop_abaixo_entrada(self):
        """Para compra: stop deve estar abaixo do nível S/R."""
        stops = calcular_stops('compra', preco_entrada=1.1050, nivel_sr=1.1000, ratio_rr=1.5)
        assert stops['stop_loss'] < 1.1050
        assert stops['stop_loss'] < stops['take_profit']

    def test_venda_stop_acima_entrada(self):
        """Para venda: stop deve estar acima do nível S/R."""
        stops = calcular_stops('venda', preco_entrada=1.0950, nivel_sr=1.1000, ratio_rr=1.5)
        assert stops['stop_loss'] > 1.0950
        assert stops['stop_loss'] > stops['take_profit']

    def test_ratio_risco_retorno_respeitado(self):
        """Take-profit deve ser ao menos ratio_rr vezes o risco."""
        ratio = 1.5
        stops = calcular_stops('compra', 1.1050, 1.1000, ratio_rr=ratio)
        risco  = stops['risco_pips']
        tp_pip = stops['tp_pips']
        assert tp_pip >= risco * ratio - 0.1  # tolerância de arredondamento

    def test_risco_em_pips_positivo(self):
        stops = calcular_stops('compra', 1.1050, 1.1000, ratio_rr=1.5)
        assert stops['risco_pips'] > 0

    def test_stop_loss_nunca_zero(self):
        """Stop-loss nunca deve ser zero ou None."""
        stops = calcular_stops('compra', 1.1050, 1.1000)
        assert stops['stop_loss'] != 0
        assert stops['stop_loss'] is not None


# ─────────────────────────────────────────────────────────────
# TESTES: VERIFICAÇÃO DE SAÍDA
# ─────────────────────────────────────────────────────────────

class TestVerificaSaida:

    def _posicao(self, sinal, stop_loss, take_profit, forca_anterior=0.0):
        return {
            'sinal'           : sinal,
            'stop_loss'       : stop_loss,
            'take_profit'     : take_profit,
            'forca_anterior'  : forca_anterior,
        }

    def test_stop_loss_compra(self):
        """Preço cair ao/abaixo do stop deve fechar compra."""
        pos = self._posicao('compra', stop_loss=1.0990, take_profit=1.1100)
        resultado = verificar_saida(1.0990, pos, indice_forca=0.0)
        assert resultado['fechar'] is True
        assert 'Stop' in resultado['motivo']

    def test_take_profit_compra(self):
        """Preço subir ao/acima do TP deve fechar compra."""
        pos = self._posicao('compra', stop_loss=1.0990, take_profit=1.1100)
        resultado = verificar_saida(1.1100, pos, indice_forca=0.0)
        assert resultado['fechar'] is True
        assert 'Take' in resultado['motivo']

    def test_stop_loss_venda(self):
        """Preço subir ao/acima do stop deve fechar venda."""
        pos = self._posicao('venda', stop_loss=1.1050, take_profit=1.0900)
        resultado = verificar_saida(1.1050, pos, indice_forca=0.0)
        assert resultado['fechar'] is True

    def test_take_profit_venda(self):
        """Preço cair ao/abaixo do TP deve fechar venda."""
        pos = self._posicao('venda', stop_loss=1.1050, take_profit=1.0900)
        resultado = verificar_saida(1.0900, pos, indice_forca=0.0)
        assert resultado['fechar'] is True

    def test_exaustao_fecha_posicao(self):
        """RAFI forte → fraco deve sinalizar exaustão."""
        pos = self._posicao('compra', 1.0990, 1.1100, forca_anterior=3.0)
        resultado = verificar_saida(1.1020, pos, indice_forca=-3.0)
        assert resultado['fechar'] is True
        assert 'Exaustão' in resultado['motivo'] or 'exaust' in resultado['motivo'].lower()

    def test_posicao_mantida_sem_gatilho(self):
        """Preço no meio do range sem exaustão não deve fechar."""
        pos = self._posicao('compra', 1.0990, 1.1100, forca_anterior=1.0)
        resultado = verificar_saida(1.1050, pos, indice_forca=1.5)
        assert resultado['fechar'] is False
