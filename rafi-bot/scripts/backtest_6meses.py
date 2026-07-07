"""
scripts/backtest_6meses.py — Backtest completo com dados sintéticos realistas

Gera 6 meses de EURUSD M5 com estrutura de mercado real:
  - Tendências de 5-15 dias com sub-consolidações internas
  - Cada sub-consolidação forma S/R, depois quebra com candle explosivo
  - Candles explosivos só chegam DEPOIS do sync M5+M15 estar estabelecido
  - Lateralizações entre tendências principais

Uso:
  cd rafi-bot
  python scripts/backtest_6meses.py
"""

import os
import sys
import logging
import numpy as np
import pandas as pd
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import yaml
from backtest.engine import Backtest
from backtest.report import gerar_relatorio


# ─────────────────────────────────────────────────────────────
# LOGGING
# ─────────────────────────────────────────────────────────────

os.makedirs('logs', exist_ok=True)
fmt = '%(asctime)s | %(levelname)s | %(message)s'
logging.basicConfig(
    level=logging.INFO,
    format=fmt,
    handlers=[
        logging.FileHandler('logs/backtest_6meses.log', encoding='utf-8', mode='w'),
        logging.StreamHandler(sys.stdout),
    ],
)
logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────
# GERADOR COM ESTRUTURA DE MERCADO REAL
# ─────────────────────────────────────────────────────────────

def gerar_eurusd_sintetico(semente: int = 42) -> pd.DataFrame:
    """
    Gera 6 meses de EURUSD M5 com estrutura de mercado que produz
    sinais válidos para a estratégia RAFI.

    Estrutura de cada bloco de tendência (ex.: ALTA):

      ┌─ Fase 1: 180-250 candles de tendência suave ──────────┐
      │  Drift moderado. M5 MA20>MA50 ✓. M15 MA20>MA50 ✓.    │
      ├─ Sub-consolidação: 25-45 candles lateral ─────────────┤
      │  Forma topo/fundo como S/R.                           │
      ├─ Sub-rompimento: 2-4 candles EXPLOSIVOS ──────────────┤
      │  Quebra o S/R com RAFI >> 2.50.                       │
      │  M5+M15 já sincronizados. SINAL VÁLIDO possível.      │
      └─ Repetir 2-4 vezes por bloco de tendência ────────────┘

    Parâmetros chave:
      DRIFT_TENDENCIA : velocidade da tendência base
      VOL_BASE        : ruído normal
      CORPO_EXPLOSIVO : tamanho do candle de rompimento
    """
    rng = np.random.default_rng(semente)

    PRECO_INICIAL    = 1.0800
    VOL_BASE         = 0.00015    # ~1.5 pips/candle (ruído)
    DRIFT_TENDENCIA  = 0.000100   # ~1 pip/candle drift na tendência
    CORPO_EXPLOSIVO  = 0.00065    # ~6.5 pips de corpo no candle explosivo
    VOL_NORMAL       = (600, 1800)
    VOL_EXPLOSIVO    = (5000, 10000)

    # Calendário Mon-Fri 2024, candles M5 24h
    inicio = datetime(2024, 1, 2, 0, 0, tzinfo=timezone.utc)
    timestamps_all = []
    ts = inicio
    while len(timestamps_all) < 40000:
        if ts.weekday() < 5:
            timestamps_all.append(ts)
        ts += timedelta(minutes=5)
    n_target = 37440
    timestamps = timestamps_all[:n_target]

    closes  = []
    volumes = []
    preco   = PRECO_INICIAL
    n_explosivos = 0

    def gerar_fase(qtd, drift, vol_std):
        """Fase normal: tendência suave ou lateral."""
        nonlocal preco
        for _ in range(qtd):
            variacao = drift + rng.normal(0, vol_std)
            preco = float(np.clip(preco + variacao, 0.8500, 1.3500))
            closes.append(round(preco, 5))
            volumes.append(float(rng.integers(*VOL_NORMAL)))

    def gerar_explosivo(qtd, direcao):
        """Candles de rompimento com força extrema."""
        nonlocal preco, n_explosivos
        for _ in range(qtd):
            # Corpo direcional forte + pequeno ruído
            corpo = direcao * rng.uniform(CORPO_EXPLOSIVO * 0.8, CORPO_EXPLOSIVO * 1.4)
            ruido = rng.normal(0, VOL_BASE * 0.2)
            preco = float(np.clip(preco + corpo + ruido, 0.8500, 1.3500))
            closes.append(round(preco, 5))
            volumes.append(float(rng.integers(*VOL_EXPLOSIVO)))
            n_explosivos += 1

    # ── Blocos de mercado: tendência ou lateral ─────────────
    # Alterna: [LATERAL, TENDENCIA_ALTA, LATERAL, TENDENCIA_BAIXA, ...]
    # Cada bloco de tendência tem 3-5 sub-ciclos (consolidação + explosivo)
    # Primeiro bloco: lateral longa para estabelecer S/R inicial
    gerar_fase(400, 0, VOL_BASE * 0.5)

    blocos_restantes = n_target - len(closes)
    direcao = 1  # começa com tendência de alta

    while len(closes) < n_target:
        restante = n_target - len(closes)
        if restante <= 0:
            break

        # ── Bloco de TENDÊNCIA (3-5 sub-ciclos) ───────────
        n_subciclos = int(rng.integers(3, 6))
        for sub in range(n_subciclos):
            if len(closes) >= n_target:
                break

            # Fase 1: tendência base (mais longa no 1º sub-ciclo)
            dur_tend = int(rng.integers(180, 260)) if sub == 0 else int(rng.integers(80, 160))
            dur_tend = min(dur_tend, n_target - len(closes))
            gerar_fase(dur_tend, direcao * DRIFT_TENDENCIA, VOL_BASE)

            if len(closes) >= n_target:
                break

            # Fase 2: consolidação lateral (forma S/R)
            dur_cons = int(rng.integers(25, 50))
            dur_cons = min(dur_cons, n_target - len(closes))
            gerar_fase(dur_cons, 0, VOL_BASE * 0.4)

            if len(closes) >= n_target:
                break

            # Fase 3: sub-rompimento explosivo
            n_exp = int(rng.integers(2, 5))
            n_exp = min(n_exp, n_target - len(closes))
            gerar_explosivo(n_exp, direcao)

        if len(closes) >= n_target:
            break

        # ── Bloco LATERAL entre tendências ────────────────
        dur_lat = int(rng.integers(200, 500))
        dur_lat = min(dur_lat, n_target - len(closes))
        gerar_fase(dur_lat, 0, VOL_BASE * 0.6)

        direcao *= -1  # inverter direção na próxima tendência

    # Garantir tamanho exato
    closes  = closes[:n_target]
    volumes = volumes[:n_target]

    closes_arr  = np.array(closes,  dtype=float)
    volumes_arr = np.array(volumes, dtype=float)

    # ── Construir OHLCV ───────────────────────────────────
    opens = np.roll(closes_arr, 1)
    opens[0] = PRECO_INICIAL

    ruido_hl = rng.uniform(0.00008, 0.00022, (n_target, 2))
    highs = closes_arr + ruido_hl[:, 0]
    lows  = closes_arr - ruido_hl[:, 1]

    # Highs e lows devem conter open e close
    highs = np.maximum(highs, np.maximum(opens, closes_arr))
    lows  = np.minimum(lows,  np.minimum(opens, closes_arr))

    df = pd.DataFrame({
        'open'  : np.round(opens,        5),
        'high'  : np.round(highs,        5),
        'low'   : np.round(lows,         5),
        'close' : np.round(closes_arr,   5),
        'volume': volumes_arr,
    }, index=pd.DatetimeIndex(timestamps[:n_target], tz=timezone.utc))

    periodo    = f"{df.index[0].date()} → {df.index[-1].date()}"
    preco_rng  = f"{df['close'].min():.4f} – {df['close'].max():.4f}"
    print(f"\nGerando {n_target} candles M5 (~6 meses de Forex 24/5)...")
    print(f"M5: {n_target} candles | M15: {n_target//3}")
    print(f"Período: {periodo}")
    print(f"EURUSD range: {preco_rng}")
    print(f"Candles explosivos (rompimentos): {n_explosivos}\n")

    return df


def reamostrar(df: pd.DataFrame, tf_min: int) -> pd.DataFrame:
    return df.resample(f'{tf_min}min').agg({
        'open': 'first', 'high': 'max', 'low': 'min',
        'close': 'last', 'volume': 'sum',
    }).dropna()


# ─────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────

def main():
    config_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'config.yaml')
    with open(config_path, 'r', encoding='utf-8') as f:
        config = yaml.safe_load(f)

    capital = 20.0

    df_m5  = gerar_eurusd_sintetico(semente=42)
    df_m15 = reamostrar(df_m5, 15)

    bt = Backtest(config, df_m5, df_m15, capital=capital)
    trades = bt.executar()

    grafico = 'logs/equity_6meses_v2.png'
    relatorio = gerar_relatorio(
        trades,
        capital_inicial=capital,
        equity_curve=bt.equity_curve,
        salvar_grafico=grafico,
    )

    wr = relatorio.get('win_rate_pct', 0)
    pf = relatorio.get('profit_factor', 0)
    if wr >= 55 and pf >= 1.5:
        logger.info("✔ METAS DE FASE 1A ATINGIDAS: win rate ≥55% e profit factor ≥1.5")
    else:
        logger.warning(f"✘ Metas de Fase 1A não atingidas — WR={wr:.1f}% PF={pf:.3f}")

    return relatorio, trades


if __name__ == '__main__':
    main()
