"""
risk_manager.py — Gestão de risco e dimensionamento de posição

Regras INEGOCIÁVEIS (Seção 2.5 do documento mestre):
  - Risco máximo por trade: 1–2% do capital
  - Máximo 2 trades simultâneos
  - 1 perda por dia → bot para até o dia seguinte
  - Perda máxima diária: 5% do capital
  - Sem martingale, sem grid, sem dobrar após perda
  - Alavancagem máxima efetiva conservadora

Adaptado para conta XM Ultra Low Standard com alavancagem 1:1000 e
capital inicial de $20 (fase de crescimento agressivo $20→$300k).
"""

import logging
from datetime import date, datetime
from typing import Optional

logger = logging.getLogger(__name__)


class GestorRisco:
    """
    Controla o risco de cada trade e limites diários.

    Uso:
      gr = GestorRisco(config)
      lote = gr.calcular_lote(capital_atual, risco_pips, spread_pips)
      if gr.pode_operar():
          ...
      gr.registrar_trade(resultado_pips, capital_atual)
    """

    def __init__(self, config: dict):
        self.risco_por_trade      = float(config.get('risco_por_trade', 0.02))
        self.risco_maximo_diario  = float(config.get('risco_maximo_diario', 0.05))
        self.max_trades_simult    = int(config.get('max_trades_simultaneos', 1))
        self.max_perdas_dia       = int(config.get('max_perdas_por_dia', 1))
        self.alavancagem          = int(config.get('alavancagem', 1000))
        self.spread_pips          = float(config.get('spread_pips', 0.8))
        self.slippage_pips        = float(config.get('slippage_pips', 0.5))
        self.lote_minimo          = float(config.get('tamanho_lote_minimo', 0.01))
        self.ratio_rr             = float(config.get('ratio_risco_retorno', 1.5))
        self.par                  = config.get('par', 'EURUSD')
        # Lote proporcional ao capital: escala o lote conforme o capital cresce
        self.lote_proporcional    = bool(config.get('lote_proporcional', False))
        self.lote_base            = float(config.get('lote_base', 0.10))
        self.capital_base         = float(config.get('capital_base', 20.0))
        self.lote_maximo          = float(config.get('lote_maximo', 100.0))
        # Lote fixo (legado): quando > 0 e proporcional=false, usa sempre este valor
        self.lote_fixo            = float(config.get('lote_fixo', 0.0))

        # Estado diário — resetado a cada novo dia
        self._data_atual: date     = date.today()
        self._perdas_dia: int      = 0
        self._perda_total_dia: float = 0.0     # USD perdido hoje
        self._trades_abertos: int  = 0
        self._parado_hoje: bool    = False

    # ─────────────────────────────────────────────────────────
    # VERIFICAÇÃO DE PERMISSÃO PARA OPERAR
    # ─────────────────────────────────────────────────────────

    def pode_operar(self, capital_atual: float) -> tuple[bool, str]:
        """
        Verifica se o bot está autorizado a abrir um novo trade.

        Retorna (True, '') ou (False, motivo_do_bloqueio).
        Em modo live, chamar avancar_data(date.today()) antes de pode_operar.
        """
        # Verificação 1: bot parado por perda
        if self._parado_hoje:
            return False, f"Bot parado: {self._perdas_dia} perda(s) hoje (limite: {self.max_perdas_dia})"

        # Verificação 2: limite de trades simultâneos
        if self._trades_abertos >= self.max_trades_simult:
            return False, f"Limite de trades simultâneos atingido ({self._trades_abertos}/{self.max_trades_simult})"

        # Verificação 3: perda diária máxima
        perda_pct = self._perda_total_dia / capital_atual if capital_atual > 0 else 0
        if perda_pct >= self.risco_maximo_diario:
            self._parado_hoje = True
            return False, (
                f"Perda diária máxima atingida: {perda_pct*100:.1f}% "
                f"(limite: {self.risco_maximo_diario*100:.0f}%)"
            )

        return True, ''

    # ─────────────────────────────────────────────────────────
    # DIMENSIONAMENTO DE POSIÇÃO
    # ─────────────────────────────────────────────────────────

    def calcular_lote(self,
                      capital_atual: float,
                      risco_pips: float,
                      incluir_spread: bool = True) -> float:
        """
        Calcula o tamanho do lote baseado no risco percentual do capital.

        Fórmula:
          valor_risco  = capital * risco_por_trade
          pip_value    = 10 USD/pip por lote padrão (EURUSD)
          lote         = valor_risco / (risco_pips * pip_value)

        O spread e o slippage são somados ao risco efetivo.

        Parâmetros:
          capital_atual  : capital disponível em USD
          risco_pips     : distância em pips até o stop-loss
          incluir_spread : adicionar spread ao cálculo de risco

        Retorna:
          float — tamanho do lote arredondado para 2 casas decimais
        """
        # Modo proporcional: escala o lote conforme o capital cresce
        # Fórmula: lote = (capital_atual / capital_base) × lote_base
        if self.lote_proporcional:
            lote = (capital_atual / self.capital_base) * self.lote_base
            lote = max(self.lote_minimo, min(lote, self.lote_maximo))
            lote = round(lote, 2)
            margem_aprox = lote * 114.50  # ~$114.50 de margem por lote no EURUSD XM 1:1000
            logger.info(
                f"Lote proporcional: {lote} | Capital: ${capital_atual:.2f} "
                f"| Pip value: ${lote * 10:.2f}/pip | Margem aprox: ${margem_aprox:.2f}"
            )
            return lote

        # Modo lote fixo (legado)
        if self.lote_fixo > 0:
            logger.info(f"Lote fixo: {self.lote_fixo} | Pip value: ${self.lote_fixo * 10:.2f}/pip")
            return self.lote_fixo

        if risco_pips <= 0 or capital_atual <= 0:
            logger.warning("Parâmetros inválidos para cálculo de lote")
            return self.lote_minimo

        # Acréscimo de custo operacional ao risco
        custo_extra = (self.spread_pips + self.slippage_pips) if incluir_spread else 0.0
        risco_total_pips = risco_pips + custo_extra

        # Valor em USD que o bot aceita perder neste trade
        valor_risco_usd = capital_atual * self.risco_por_trade

        # Para EURUSD: 1 pip = $10 por lote padrão (100.000 unidades)
        pip_value_por_lote = 10.0  # USD/pip para lote padrão EURUSD

        lote = valor_risco_usd / (risco_total_pips * pip_value_por_lote)

        # Aplicar limites: mínimo 0.01, máximo determinado pela alavancagem disponível
        lote_max = self._lote_maximo(capital_atual)
        lote = max(self.lote_minimo, min(lote, lote_max))
        lote = round(lote, 2)

        logger.info(
            f"Lote calculado: {lote} | Capital: ${capital_atual:.2f} | "
            f"Risco: {risco_pips}p + {custo_extra}p = {risco_total_pips}p | "
            f"Risco USD: ${valor_risco_usd:.2f}"
        )
        return lote

    def _lote_maximo(self, capital: float) -> float:
        """
        Determina o lote máximo permitido pela margem disponível.

        Com alavancagem 1:1000 e capital em USD:
          margem_necessária = (lote * 100.000) / alavancagem
          lote_max = (capital * alavancagem) / 100.000

        Limitado a alavancagem efetiva de 1:50 para conservadorismo.
        """
        alavancagem_efetiva = min(self.alavancagem, 50)  # conservador
        lote_max = (capital * alavancagem_efetiva) / 100_000.0
        return max(self.lote_minimo, round(lote_max, 2))

    # ─────────────────────────────────────────────────────────
    # REGISTRO DE TRADES
    # ─────────────────────────────────────────────────────────

    def abrir_trade(self) -> None:
        """Registra a abertura de um novo trade."""
        self._trades_abertos += 1
        logger.debug(f"Trade aberto. Total abertos: {self._trades_abertos}")

    def fechar_trade(self,
                     resultado_usd: float,
                     capital_atual: float) -> None:
        """
        Registra o fechamento de um trade.

        Parâmetros:
          resultado_usd : lucro (positivo) ou prejuízo (negativo) em USD
          capital_atual : capital após o fechamento
        """
        self._trades_abertos = max(0, self._trades_abertos - 1)

        if resultado_usd < 0:
            self._perdas_dia       += 1
            self._perda_total_dia  += abs(resultado_usd)

            logger.warning(
                f"Perda registrada: ${abs(resultado_usd):.2f} | "
                f"Perdas hoje: {self._perdas_dia}/{self.max_perdas_dia}"
            )

            # Verificar limite de perdas por dia
            if self._perdas_dia >= self.max_perdas_dia:
                self._parado_hoje = True
                logger.warning(
                    f"BOT PAUSADO: atingido limite de {self.max_perdas_dia} "
                    f"perda(s) por dia. Retomará amanhã."
                )

            # Verificar perda diária percentual
            perda_pct = self._perda_total_dia / capital_atual if capital_atual > 0 else 0
            if perda_pct >= self.risco_maximo_diario:
                self._parado_hoje = True
                logger.warning(
                    f"BOT PAUSADO: perda diária de {perda_pct*100:.1f}% "
                    f"(limite: {self.risco_maximo_diario*100:.0f}%)"
                )
        else:
            logger.info(f"Lucro registrado: ${resultado_usd:.2f}")

    # ─────────────────────────────────────────────────────────
    # STATUS E RESET
    # ─────────────────────────────────────────────────────────

    def status(self, capital_atual: float) -> dict:
        """Retorna o estado atual do gestor de risco."""
        perda_pct = self._perda_total_dia / capital_atual if capital_atual > 0 else 0
        return {
            'pode_operar'      : not self._parado_hoje,
            'trades_abertos'   : self._trades_abertos,
            'perdas_hoje'      : self._perdas_dia,
            'perda_total_usd'  : round(self._perda_total_dia, 2),
            'perda_pct_dia'    : round(perda_pct * 100, 2),
            'parado_hoje'      : self._parado_hoje,
        }

    def avancar_data(self, data: date) -> None:
        """
        Avança o calendário interno para a data fornecida.
        Usado pelo backtest para passar a data simulada do candle atual,
        evitando que date.today() bloqueie o reset diário.
        """
        self._resetar_se_novo_dia(data)

    def _resetar_se_novo_dia(self, data: date = None) -> None:
        """Reseta os contadores ao detectar virada de dia."""
        hoje = data if data is not None else date.today()
        if hoje != self._data_atual:
            logger.info(
                f"Novo dia ({hoje}). Resetando contadores de risco diário."
            )
            self._data_atual      = hoje
            self._perdas_dia      = 0
            self._perda_total_dia = 0.0
            self._parado_hoje     = False
            # Não reseta trades abertos — podem continuar do dia anterior
