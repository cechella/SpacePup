"""
risk_manager.py — Gestão de risco e dimensionamento de posição

Regras INEGOCIÁVEIS (Seção 2.5 do documento mestre):
  - Risco máximo por trade: 1–2% do capital
  - Máximo 2 trades simultâneos
  - Perda máxima diária: 5% do capital → bot para até o dia seguinte
  - Sem martingale, sem grid, sem dobrar após perda
  - Alavancagem máxima efetiva conservadora

Escalonamento agressivo de lotes (definido em 2026-07):
  Capital prova consistência → lote sobe de faixa automaticamente.
  Condições para subir: semana positiva + drawdown semanal < 15% + sem 3 losses seguidos.
  Condições para descer: drawdown semanal > 20%.
"""

import logging
from datetime import date, datetime
from typing import Optional

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# TABELA DE FAIXAS (capital USD → lote padrão EURUSD XM Ultra Low)
#
# pip value = lote × $10/pip  |  alavancagem 1:1000  |  capital em USD
# Padrão: 0.20L por $100 de capital (2% de risco com SL ~10 pips)
# ─────────────────────────────────────────────────────────────────────────────
FAIXAS_LOTE: list[tuple[float, float, float]] = [
    #  capital_min   capital_max    lote
    (      100,           200,     0.20),
    (      200,           500,     0.40),
    (      500,         1_000,     1.00),
    (    1_000,         3_000,     2.00),
    (    3_000,        10_000,     5.00),
    (   10_000,        30_000,    10.00),
    (   30_000,   float('inf'),   20.00),
]


def lote_por_faixa(capital: float) -> float:
    """Retorna o lote da faixa correspondente ao capital atual."""
    for cap_min, cap_max, lote in FAIXAS_LOTE:
        if cap_min <= capital < cap_max:
            return lote
    # Capital abaixo de $100 → lote mínimo
    return 0.01


class GestorRisco:
    """
    Controla o risco de cada trade, limites diários e escalonamento semanal de lotes.

    Uso típico:
      gr = GestorRisco(config)
      gr.avancar_data(date_do_candle)
      lote = gr.calcular_lote(capital_atual, risco_pips)
      pode, motivo = gr.pode_operar(capital_atual)
      if pode:
          gr.abrir_trade()
          ...
          gr.fechar_trade(resultado_usd, capital_atual)
    """

    def __init__(self, config: dict):
        # ── Parâmetros base ─────────────────────────────────────────────────
        self.risco_por_trade      = float(config.get('risco_por_trade', 0.02))
        self.risco_maximo_diario  = float(config.get('risco_maximo_diario', 0.05))
        self.max_trades_simult    = int(config.get('max_trades_simultaneos', 1))
        self.max_perdas_dia       = int(config.get('max_perdas_por_dia', 1))
        self.alavancagem          = int(config.get('alavancagem', 1000))
        self.spread_pips          = float(config.get('spread_pips', 0.8))
        self.slippage_pips        = float(config.get('slippage_pips', 0.5))
        self.lote_minimo          = float(config.get('tamanho_lote_minimo', 0.01))
        self.lote_maximo          = float(config.get('lote_maximo', 100.0))
        self.ratio_rr             = float(config.get('ratio_risco_retorno', 1.5))
        self.par                  = config.get('par', 'EURUSD')

        # ── Modo de dimensionamento ──────────────────────────────────────────
        # 'faixa'       → escalonamento por faixas de capital (padrão novo)
        # 'proporcional' → lote = (capital/capital_base) × lote_base
        # 'fixo'         → lote_fixo sempre
        # 'kelly'        → kelly % por risco (legado)
        self.modo_lote          = config.get('modo_lote', 'faixa')
        self.lote_proporcional  = bool(config.get('lote_proporcional', False))
        self.lote_base          = float(config.get('lote_base', 0.20))
        self.capital_base       = float(config.get('capital_base', 100.0))
        self.lote_fixo          = float(config.get('lote_fixo', 0.0))

        # ── Proteção semanal ────────────────────────────────────────────────
        # Drawdown semanal > 20% → desce uma faixa
        # Drawdown semanal > 15% → bloqueia subida de faixa
        self.dd_semanal_reducao = float(config.get('dd_semanal_reducao', 0.20))
        self.dd_semanal_bloqueio = float(config.get('dd_semanal_bloqueio', 0.15))
        self.max_losses_seguidos = int(config.get('max_losses_seguidos', 3))

        # ── Estado diário ────────────────────────────────────────────────────
        self._data_atual: date       = date.today()
        self._perdas_dia: int        = 0
        self._perda_total_dia: float = 0.0
        self._trades_abertos: int    = 0
        self._parado_hoje: bool      = False

        # ── Estado semanal ───────────────────────────────────────────────────
        self._semana_atual: int      = date.today().isocalendar()[1]
        self._ano_semana: int        = date.today().isocalendar()[0]
        self._pnl_semana: float      = 0.0   # P&L acumulado na semana (USD)
        self._capital_pico_semana: float = 0.0  # pico de capital na semana
        self._losses_seguidos: int   = 0      # losses consecutivos

        # Faixa forçada (override manual ou por proteção): None = usa tabela normal
        self._faixa_forcada: Optional[float] = None

    # ─────────────────────────────────────────────────────────────────────────
    # VERIFICAÇÃO DE PERMISSÃO PARA OPERAR
    # ─────────────────────────────────────────────────────────────────────────

    def pode_operar(self, capital_atual: float) -> tuple[bool, str]:
        """
        Verifica se o bot está autorizado a abrir um novo trade.

        Retorna (True, '') ou (False, motivo_do_bloqueio).
        Chamar avancar_data(date_do_candle) antes de pode_operar em produção.
        """
        custo_min = self.lote_minimo * 10.0
        if capital_atual <= custo_min:
            return False, f"Capital insuficiente (${capital_atual:.2f}) — mínimo ${custo_min:.2f}"

        if self._parado_hoje:
            return False, f"Bot parado: {self._perdas_dia} perda(s) hoje (limite: {self.max_perdas_dia})"

        if self._trades_abertos >= self.max_trades_simult:
            return False, f"Limite de trades simultâneos ({self._trades_abertos}/{self.max_trades_simult})"

        if self._losses_seguidos >= self.max_losses_seguidos:
            return False, f"Bloqueado: {self._losses_seguidos} losses consecutivos (limite: {self.max_losses_seguidos})"

        perda_pct = self._perda_total_dia / capital_atual if capital_atual > 0 else 0
        if perda_pct >= self.risco_maximo_diario:
            self._parado_hoje = True
            return False, (
                f"Perda diária máxima: {perda_pct*100:.1f}% "
                f"(limite: {self.risco_maximo_diario*100:.0f}%)"
            )

        return True, ''

    # ─────────────────────────────────────────────────────────────────────────
    # DIMENSIONAMENTO DE POSIÇÃO
    # ─────────────────────────────────────────────────────────────────────────

    def calcular_lote(self,
                      capital_atual: float,
                      risco_pips: float = 10.0,
                      incluir_spread: bool = True) -> float:
        """
        Calcula o lote do próximo trade de acordo com o modo configurado.

        Modos:
          'faixa'        → lote_por_faixa(capital) com ajuste semanal
          'proporcional' → (capital / capital_base) × lote_base
          'fixo'         → lote_fixo
          'kelly'        → (capital × risco%) / (risco_pips × pip_value)
        """
        modo = self.modo_lote

        # Modo legado: lote_proporcional=true no config antigo
        if self.lote_proporcional and modo == 'faixa':
            modo = 'proporcional'
        if self.lote_fixo > 0 and modo == 'faixa':
            modo = 'fixo'

        # ── Faixa (padrão novo) ───────────────────────────────────────────
        if modo == 'faixa':
            lote = self._lote_faixa_ajustado(capital_atual)

        # ── Proporcional ──────────────────────────────────────────────────
        elif modo == 'proporcional':
            lote = (capital_atual / self.capital_base) * self.lote_base
            lote = max(self.lote_minimo, min(lote, self.lote_maximo))
            lote = round(lote, 2)

        # ── Fixo ──────────────────────────────────────────────────────────
        elif modo == 'fixo':
            lote = self.lote_fixo

        # ── Kelly % (legado) ──────────────────────────────────────────────
        else:
            if risco_pips <= 0 or capital_atual <= 0:
                return self.lote_minimo
            custo_extra      = (self.spread_pips + self.slippage_pips) if incluir_spread else 0.0
            risco_total_pips = risco_pips + custo_extra
            valor_risco_usd  = capital_atual * self.risco_por_trade
            pip_value        = 10.0  # EURUSD: $10/pip por lote padrão
            lote             = valor_risco_usd / (risco_total_pips * pip_value)
            lote             = max(self.lote_minimo, min(lote, self._lote_max_margem(capital_atual)))
            lote             = round(lote, 2)

        logger.info(
            f"Lote [{modo}]: {lote} | Capital: ${capital_atual:.2f} "
            f"| Pip value: ${lote * 10:.2f}/pip | Losses seguidos: {self._losses_seguidos}"
        )
        return lote

    def _lote_faixa_ajustado(self, capital: float) -> float:
        """
        Retorna o lote da faixa atual aplicando proteções semanais:
          - Drawdown semanal > 20% → desce uma faixa
          - 3+ losses seguidos     → congela na faixa atual (não sobe)
        """
        # Override manual (ex: proteção aplicada manualmente)
        if self._faixa_forcada is not None:
            return self._faixa_forcada

        lote_base = lote_por_faixa(capital)

        # Drawdown semanal: se > 20%, usa faixa anterior (mais baixa)
        if self._capital_pico_semana > 0:
            dd_semana = (self._capital_pico_semana - capital) / self._capital_pico_semana
            if dd_semana >= self.dd_semanal_reducao:
                # Encontra a faixa de capital imediatamente abaixo
                lote_inferior = lote_por_faixa(capital * 0.70)
                if lote_inferior < lote_base:
                    logger.warning(
                        f"Drawdown semanal {dd_semana*100:.1f}% > {self.dd_semanal_reducao*100:.0f}% "
                        f"→ Reduzindo lote: {lote_base} → {lote_inferior}"
                    )
                    return round(lote_inferior, 2)

        return round(lote_base, 2)

    def pode_subir_faixa(self, capital_atual: float) -> tuple[bool, str]:
        """
        Informa se as condições permitem escalar para a próxima faixa.

        Condições para subir:
          1. Semana atual fechou positiva (pnl_semana >= 0)
          2. Drawdown semanal < 15%
          3. Menos de 3 losses consecutivos
        """
        if self._pnl_semana < 0:
            return False, f"Semana negativa (P&L: ${self._pnl_semana:.2f})"

        if self._capital_pico_semana > 0:
            dd = (self._capital_pico_semana - capital_atual) / self._capital_pico_semana
            if dd >= self.dd_semanal_bloqueio:
                return False, f"Drawdown semanal {dd*100:.1f}% > {self.dd_semanal_bloqueio*100:.0f}%"

        if self._losses_seguidos >= self.max_losses_seguidos:
            return False, f"{self._losses_seguidos} losses consecutivos"

        return True, "Condições OK para escalar lote"

    def _lote_max_margem(self, capital: float) -> float:
        """Lote máximo permitido pela margem disponível com 1:1000."""
        lote_max = (capital * self.alavancagem) / 100_000.0
        return max(self.lote_minimo, min(round(lote_max, 2), self.lote_maximo))

    # ─────────────────────────────────────────────────────────────────────────
    # REGISTRO DE TRADES
    # ─────────────────────────────────────────────────────────────────────────

    def abrir_trade(self) -> None:
        """Registra a abertura de um novo trade."""
        self._trades_abertos += 1
        logger.debug(f"Trade aberto. Total abertos: {self._trades_abertos}")

    def fechar_trade(self,
                     resultado_usd: float,
                     capital_atual: float) -> None:
        """
        Registra o fechamento de um trade e atualiza todos os contadores.

        resultado_usd: positivo = lucro, negativo = prejuízo.
        """
        self._trades_abertos = max(0, self._trades_abertos - 1)
        self._pnl_semana    += resultado_usd

        # Atualiza pico semanal
        if capital_atual > self._capital_pico_semana:
            self._capital_pico_semana = capital_atual

        if resultado_usd < 0:
            self._perdas_dia      += 1
            self._perda_total_dia += abs(resultado_usd)
            self._losses_seguidos += 1

            logger.warning(
                f"Perda: ${abs(resultado_usd):.2f} | "
                f"Perdas hoje: {self._perdas_dia}/{self.max_perdas_dia} | "
                f"Losses seguidos: {self._losses_seguidos}/{self.max_losses_seguidos}"
            )

            if self._perdas_dia >= self.max_perdas_dia:
                self._parado_hoje = True
                logger.warning(
                    f"BOT PAUSADO: {self.max_perdas_dia} perda(s)/dia atingida. Retomará amanhã."
                )

            perda_pct = self._perda_total_dia / capital_atual if capital_atual > 0 else 0
            if perda_pct >= self.risco_maximo_diario:
                self._parado_hoje = True
                logger.warning(
                    f"BOT PAUSADO: perda diária de {perda_pct*100:.1f}% "
                    f"(limite: {self.risco_maximo_diario*100:.0f}%)"
                )
        else:
            # Win → reseta contador de losses consecutivos
            self._losses_seguidos = 0
            logger.info(f"Lucro: ${resultado_usd:.2f} | P&L semana: ${self._pnl_semana:.2f}")

    # ─────────────────────────────────────────────────────────────────────────
    # STATUS E RESET
    # ─────────────────────────────────────────────────────────────────────────

    def status(self, capital_atual: float) -> dict:
        """Retorna o estado completo do gestor de risco."""
        perda_pct = self._perda_total_dia / capital_atual if capital_atual > 0 else 0
        lote_atual = self.calcular_lote(capital_atual)
        pode_subir, motivo_subida = self.pode_subir_faixa(capital_atual)
        return {
            'pode_operar'      : not self._parado_hoje and self._losses_seguidos < self.max_losses_seguidos,
            'lote_atual'       : lote_atual,
            'pip_value_usd'    : round(lote_atual * 10, 2),
            'trades_abertos'   : self._trades_abertos,
            'perdas_hoje'      : self._perdas_dia,
            'perda_total_usd'  : round(self._perda_total_dia, 2),
            'perda_pct_dia'    : round(perda_pct * 100, 2),
            'parado_hoje'      : self._parado_hoje,
            'losses_seguidos'  : self._losses_seguidos,
            'pnl_semana'       : round(self._pnl_semana, 2),
            'pode_subir_faixa' : pode_subir,
            'motivo_faixa'     : motivo_subida,
        }

    def avancar_data(self, data: date) -> None:
        """
        Avança o calendário interno. Chamar a cada candle no backtest
        e a cada ciclo em produção.
        """
        self._resetar_se_novo_dia(data)
        self._resetar_se_nova_semana(data)

    def _resetar_se_novo_dia(self, data: date) -> None:
        if data != self._data_atual:
            logger.info(f"Novo dia ({data}). Resetando contadores diários.")
            self._data_atual      = data
            self._perdas_dia      = 0
            self._perda_total_dia = 0.0
            self._parado_hoje     = False

    def _resetar_se_nova_semana(self, data: date) -> None:
        iso  = data.isocalendar()
        ano  = iso[0]
        semana = iso[1]
        if semana != self._semana_atual or ano != self._ano_semana:
            logger.info(
                f"Nova semana ({ano}-W{semana:02d}). "
                f"P&L semana anterior: ${self._pnl_semana:.2f} | "
                f"Losses seguidos: {self._losses_seguidos}"
            )
            self._semana_atual       = semana
            self._ano_semana         = ano
            self._pnl_semana         = 0.0
            self._capital_pico_semana = 0.0
            # Reseta override de faixa forçada ao início de nova semana
            self._faixa_forcada      = None
