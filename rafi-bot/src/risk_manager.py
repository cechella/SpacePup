"""
risk_manager.py — Gestão de risco e dimensionamento de posição

Regras INEGOCIÁVEIS (Seção 2.5 do documento mestre):
  - Risco máximo por trade: 1–2% do capital
  - Máximo 2 trades simultâneos
  - Perda máxima diária: 5% do capital → bot para até o dia seguinte
  - Sem martingale, sem grid, sem dobrar após perda
  - Alavancagem máxima efetiva conservadora

Escalonamento de lotes: definido exclusivamente no admin dashboard → Supabase
  (tabela rafi_lote_faixas). Zero valores hardcoded neste arquivo.
  Se o Supabase estiver inacessível e não houver cache → SupabaseIndisponivel
  é levantado e o bot para de operar até a conexão ser restabelecida.
"""

import logging
import time
from datetime import date, datetime
from typing import Optional

logger = logging.getLogger(__name__)


# Cache em memória das faixas e config de risco carregados do Supabase.
# Refresca a cada 5 minutos. Se o Supabase estiver indisponível e o cache
# estiver vazio → bot levanta SupabaseIndisponivel e para de operar.
# Regra INEGOCIÁVEL: zero valores hardcoded — fonte única = Supabase/admin.
_faixas_cache: list[tuple[float, float, float]] = []
_faixas_ts: float = 0.0
_risco_cache: dict = {}
_risco_ts: float = 0.0
_CACHE_TTL = 300  # segundos


class SupabaseIndisponivel(RuntimeError):
    """Levantado quando o Supabase está inacessível e não há cache válido."""


def _faixas_vigentes() -> list[tuple[float, float, float]]:
    """
    Retorna as faixas de lote do cache ou do Supabase.

    Se o Supabase estiver indisponível:
      - Cache ainda válido → usa o cache (bot continua com os valores já conhecidos)
      - Cache vazio → levanta SupabaseIndisponivel (bot para, não opera sem dados)
    """
    global _faixas_cache, _faixas_ts
    agora = time.monotonic()
    if agora - _faixas_ts < _CACHE_TTL and _faixas_cache:
        return _faixas_cache
    try:
        from .supabase_sync import carregar_faixas_lote
        faixas = carregar_faixas_lote()
        if faixas:
            _faixas_cache = faixas
            _faixas_ts = agora
            # Log completo da tabela para auditoria — aparece no log toda vez que recarrega
            partes = []
            for cap_min, cap_max, lote in faixas:
                cap_max_str = f"${cap_max:.0f}" if cap_max != float('inf') else "∞"
                partes.append(f"${cap_min:.0f}-{cap_max_str}→{lote}L")
            logger.info(f"[FAIXAS] Tabela carregada do Supabase: {' | '.join(partes)}")
            return _faixas_cache
    except Exception as e:
        logger.warning(f"[RiskManager] Supabase indisponível para faixas: {e}")
    # Sem Supabase: usa cache se existir, senão para o bot
    if _faixas_cache:
        logger.warning("[RiskManager] Supabase indisponível — usando cache de faixas anterior")
        return _faixas_cache
    raise SupabaseIndisponivel(
        "Tabela rafi_lote_faixas inacessível e cache vazio — bot para até o Supabase voltar"
    )


def lote_por_faixa(capital: float,
                   faixas: Optional[list[tuple[float, float, float]]] = None) -> float:
    """
    Retorna o lote correspondente ao capital atual.

    Se `faixas` for passado (ex.: pelo backtest a partir do config.yaml),
    usa essas faixas diretamente sem consultar o Supabase — permite rodar
    backtests offline. Em produção (faixas=None), lê do Supabase/cache.

    Levanta SupabaseIndisponivel se o Supabase estiver inacessível, não
    houver cache e faixas=None — garantindo que o bot nunca opere com
    valores desconhecidos.
    """
    fonte = faixas if faixas is not None else _faixas_vigentes()
    for cap_min, cap_max, lote in fonte:
        if cap_min <= capital < cap_max:
            return lote
    raise SupabaseIndisponivel(
        f"Capital {capital:.2f} não encontrado em nenhuma faixa — verifique rafi_lote_faixas"
    )


def recarregar_faixas_lote() -> None:
    """Força recarregamento imediato das faixas do Supabase (ignora cache TTL)."""
    global _faixas_ts
    _faixas_ts = 0.0
    _faixas_vigentes()


def _config_risco_vigente() -> dict:
    """
    Retorna os parâmetros de risco do cache ou do Supabase (rafi_config_risco).

    Se o Supabase estiver indisponível:
      - Cache ainda válido → usa o cache (bot continua com valores já conhecidos)
      - Cache vazio → levanta SupabaseIndisponivel (bot para)
    """
    global _risco_cache, _risco_ts
    agora = time.monotonic()
    if agora - _risco_ts < _CACHE_TTL and _risco_cache:
        return _risco_cache
    try:
        from .supabase_sync import carregar_config_risco
        dados = carregar_config_risco()
        if dados:
            _risco_cache = dados
            _risco_ts = agora
            logger.info(f"[RISCO] Config carregada do Supabase: {dados}")
            return _risco_cache
    except Exception as e:
        logger.warning(f"[RiskManager] Supabase indisponível para config_risco: {e}")
    if _risco_cache:
        logger.warning("[RiskManager] Supabase indisponível — usando cache de config_risco anterior")
        return _risco_cache
    raise SupabaseIndisponivel(
        "Tabela rafi_config_risco inacessível e cache vazio — bot para até o Supabase voltar"
    )


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
        # ── Parâmetros lidos do Supabase (rafi_config_risco) ────────────────
        # Fonte única de verdade: Admin Dashboard → Supabase → aqui.
        # Zero valores operacionais hardcoded — bot para se Supabase cair.
        risco = _config_risco_vigente()

        self.max_trades_simult   = int(risco.get('max_trades_simultaneos', 1))
        self.lote_minimo         = float(risco.get('tamanho_lote_minimo', 0.01))
        self.lote_maximo         = float(risco.get('lote_maximo', 100.0))
        self.par                 = str(risco.get('par', 'EURUSD'))
        self.max_losses_seguidos = int(risco.get('max_losses_seguidos', 2))
        self.dd_semanal_reducao  = float(risco.get('dd_semanal_reducao', 0.20))

        # ── Estado diário ────────────────────────────────────────────────────
        self._data_atual: date           = date.today()
        self._perdas_dia: int            = 0
        self._trades_abertos: int        = 0
        self._parado_hoje: bool          = False

        # ── Estado semanal ───────────────────────────────────────────────────
        self._semana_atual: int          = date.today().isocalendar()[1]
        self._ano_semana: int            = date.today().isocalendar()[0]
        self._capital_pico_semana: float = 0.0
        self._losses_seguidos: int       = 0

        # Override manual de faixa: None = usa tabela normal
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
        if self._parado_hoje:
            return False, f"Bot parado: {self._perdas_dia} stop(s) hoje (limite: {self.max_losses_seguidos})"

        if self._trades_abertos >= self.max_trades_simult:
            return False, f"Limite de trades simultâneos ({self._trades_abertos}/{self.max_trades_simult})"

        if self._losses_seguidos >= self.max_losses_seguidos:
            return False, f"Bloqueado: {self._losses_seguidos} stops consecutivos (limite: {self.max_losses_seguidos})"

        return True, ''

    # ─────────────────────────────────────────────────────────────────────────
    # DIMENSIONAMENTO DE POSIÇÃO
    # ─────────────────────────────────────────────────────────────────────────

    def calcular_lote(self, capital_atual: float) -> float:
        """Retorna o lote da faixa atual aplicando proteção semanal de drawdown."""
        return self._lote_faixa_ajustado(capital_atual)

    def _lote_faixa_ajustado(self, capital: float) -> float:
        """Drawdown semanal > 20% → desce uma faixa automaticamente."""
        if self._faixa_forcada is not None:
            return self._faixa_forcada

        lote_base = lote_por_faixa(capital)

        if self._capital_pico_semana > 0:
            dd_semana = (self._capital_pico_semana - capital) / self._capital_pico_semana
            if dd_semana >= self.dd_semanal_reducao:
                lote_inferior = lote_por_faixa(capital * 0.70)
                if lote_inferior < lote_base:
                    logger.warning(
                        f"Drawdown semanal {dd_semana*100:.1f}% > {self.dd_semanal_reducao*100:.0f}% "
                        f"→ Lote: {lote_base} → {lote_inferior}"
                    )
                    return round(lote_inferior, 2)

        logger.info(f"[LOTE] faixa={lote_base} | capital=${capital:.2f} | pip_value=${lote_base*10:.2f}")
        return round(lote_base, 2)

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

        # Atualiza pico semanal (usado para cálculo de drawdown)
        if capital_atual > self._capital_pico_semana:
            self._capital_pico_semana = capital_atual

        if resultado_usd < 0:
            self._perdas_dia      += 1
            self._losses_seguidos += 1

            logger.warning(
                f"Stop #{self._perdas_dia} | Consecutivos: {self._losses_seguidos}/{self.max_losses_seguidos} "
                f"| Resultado: ${resultado_usd:.2f}"
            )

            if self._losses_seguidos >= self.max_losses_seguidos:
                self._parado_hoje = True
                logger.warning(
                    f"BOT PAUSADO: {self.max_losses_seguidos} stops consecutivos. Retoma amanhã (Londres/NY)."
                )
        else:
            self._losses_seguidos = 0
            logger.info(f"Lucro: ${resultado_usd:.2f}")

    # ─────────────────────────────────────────────────────────────────────────
    # STATUS E RESET
    # ─────────────────────────────────────────────────────────────────────────

    def status(self, capital_atual: float) -> dict:
        """Retorna o estado atual do gestor de risco."""
        lote_atual = self.calcular_lote(capital_atual)
        pode, motivo = self.pode_operar(capital_atual)
        return {
            'pode_operar'     : pode,
            'motivo_bloqueio' : motivo,
            'lote_atual'      : lote_atual,
            'pip_value_usd'   : round(lote_atual * 10, 2),
            'trades_abertos'  : self._trades_abertos,
            'perdas_hoje'     : self._perdas_dia,
            'parado_hoje'     : self._parado_hoje,
            'losses_seguidos' : self._losses_seguidos,
            'dd_semanal_pct'  : round(
                (self._capital_pico_semana - capital_atual) / self._capital_pico_semana * 100, 2
            ) if self._capital_pico_semana > 0 else 0.0,
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
            logger.info(f"Novo dia ({data}) — resetando: perdas={self._perdas_dia}, losses_seguidos={self._losses_seguidos}")
            self._data_atual      = data
            self._perdas_dia      = 0
            self._parado_hoje     = False

    def _resetar_se_nova_semana(self, data: date) -> None:
        iso    = data.isocalendar()
        ano    = iso[0]
        semana = iso[1]
        if semana != self._semana_atual or ano != self._ano_semana:
            logger.info(f"Nova semana ({ano}-W{semana:02d}) — resetando pico semanal.")
            self._semana_atual        = semana
            self._ano_semana          = ano
            self._capital_pico_semana = 0.0
            self._faixa_forcada       = None
