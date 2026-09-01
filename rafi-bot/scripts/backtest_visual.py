#!/usr/bin/env python3
"""
Backtest Visual — Estratégia de Rompimento S/R com Bollinger Bands
Gera prints de cada trade identificado na semana para validação manual.
"""

import yfinance as yf
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
import os
from datetime import datetime, timedelta
import warnings
warnings.filterwarnings('ignore')

# ── Diretório de saída ──────────────────────────────────────────────────────
SCRATCHPAD = "/tmp/claude-0/-home-user-SpacePup/0496f7ce-21ee-5782-84fa-0754ea33caea/scratchpad"
OUTPUT_DIR = os.path.join(SCRATCHPAD, "backtest_prints")
os.makedirs(OUTPUT_DIR, exist_ok=True)

# ── Parâmetros ──────────────────────────────────────────────────────────────
BB_PERIOD        = 8       # períodos das Bandas de Bollinger
BB_STD           = 2.0     # desvios padrão
SR_LOOKBACK      = 20      # candles para detectar S/R (topos/fundos)
SQUEEZE_RATIO    = 0.0012  # largura máxima das BB relativa ao preço (squeeze)
MIN_BREAKOUT     = 0.00003 # mínimo de distância do rompimento (3 pips)
RR_RATIO         = 1.5     # relação risco/retorno alvo
MIN_GAP_CANDLES  = 8       # mínimo de candles entre trades
CANDLES_BEFORE   = 50      # janela antes do trade no print
CANDLES_AFTER    = 25      # janela depois do trade no print


def baixar_dados(dias: int = 8) -> pd.DataFrame:
    """Baixa dados EURUSD M5 via yfinance."""
    fim   = datetime.now()
    inicio = fim - timedelta(days=dias)
    print(f"Baixando EURUSD M5 ({inicio.date()} → {fim.date()})...")
    df = yf.download("EURUSD=X", start=inicio, end=fim, interval="5m",
                     auto_adjust=True, progress=False)
    # flatten MultiIndex de colunas se existir
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = [c[0] for c in df.columns]
    df = df.dropna()
    print(f"  {len(df)} candles carregados")
    return df


def calcular_indicadores(df: pd.DataFrame) -> pd.DataFrame:
    """Calcula Bollinger Bands e níveis de S/R."""
    df = df.copy()
    df['bb_mid']   = df['Close'].rolling(BB_PERIOD).mean()
    df['bb_std']   = df['Close'].rolling(BB_PERIOD).std()
    df['bb_upper'] = df['bb_mid'] + BB_STD * df['bb_std']
    df['bb_lower'] = df['bb_mid'] - BB_STD * df['bb_std']
    df['bb_width'] = (df['bb_upper'] - df['bb_lower']) / df['bb_mid']  # relativo

    # S/R: máxima/mínima dos N candles anteriores (shift para evitar lookahead)
    df['resistencia'] = df['High'].rolling(SR_LOOKBACK).max().shift(1)
    df['suporte']     = df['Low'].rolling(SR_LOOKBACK).min().shift(1)

    return df.dropna()


def detectar_trades(df: pd.DataFrame) -> list:
    """Detecta rompimentos válidos e retorna lista de trades."""
    trades = []
    ultimo = -MIN_GAP_CANDLES

    for i in range(1, len(df)):
        if i - ultimo < MIN_GAP_CANDLES:
            continue

        atual = df.iloc[i]
        prev  = df.iloc[i - 1]

        # BB estava em squeeze e está expandindo
        era_squeeze  = prev['bb_width'] < SQUEEZE_RATIO
        expandindo   = atual['bb_width'] > prev['bb_width'] * 1.08

        if not (era_squeeze and expandindo):
            continue

        # ── COMPRA: fecha acima da resistência ──────────────────────────────
        if (atual['Close'] > atual['resistencia'] and
                atual['Close'] - atual['resistencia'] >= MIN_BREAKOUT):

            entry  = atual['resistencia']           # entrada na resistência rompida
            stop   = atual['Low'] - 0.00015         # abaixo da mínima do candle
            risco  = entry - stop
            target = entry + risco * RR_RATIO

            trades.append({
                'idx': i, 'time': df.index[i], 'direction': 'COMPRA',
                'entry': entry, 'stop': stop, 'target': target,
                'risco_pips': risco * 10000,
                'ganho_pips': risco * RR_RATIO * 10000,
                'bb_width': atual['bb_width'],
            })
            ultimo = i

        # ── VENDA: fecha abaixo do suporte ──────────────────────────────────
        elif (atual['Close'] < atual['suporte'] and
              atual['suporte'] - atual['Close'] >= MIN_BREAKOUT):

            entry  = atual['suporte']
            stop   = atual['High'] + 0.00015
            risco  = stop - entry
            target = entry - risco * RR_RATIO

            trades.append({
                'idx': i, 'time': df.index[i], 'direction': 'VENDA',
                'entry': entry, 'stop': stop, 'target': target,
                'risco_pips': risco * 10000,
                'ganho_pips': risco * RR_RATIO * 10000,
                'bb_width': atual['bb_width'],
            })
            ultimo = i

    return trades


def gerar_print(df: pd.DataFrame, trade: dict, num: int) -> str:
    """Gera e salva o print de um trade."""
    i      = trade['idx']
    ini    = max(0, i - CANDLES_BEFORE)
    fim_i  = min(len(df), i + CANDLES_AFTER)
    seg    = df.iloc[ini:fim_i].copy()
    rel    = i - ini  # posição relativa do trade no segmento

    fig, (ax1, ax2) = plt.subplots(
        2, 1, figsize=(18, 9),
        gridspec_kw={'height_ratios': [3, 1]},
        facecolor='#0d1117'
    )

    # ── Candlesticks ────────────────────────────────────────────────────────
    xs = range(len(seg))
    for j, (_, row) in enumerate(seg.iterrows()):
        cor = '#26a69a' if row['Close'] >= row['Open'] else '#ef5350'
        ax1.plot([j, j], [row['Low'], row['High']], color=cor, lw=0.8)
        ax1.bar(j, abs(row['Close'] - row['Open']),
                bottom=min(row['Open'], row['Close']),
                color=cor, width=0.7, alpha=0.9)

    # ── Bollinger Bands ──────────────────────────────────────────────────────
    ax1.plot(xs, seg['bb_upper'], color='#00bcd4', lw=1.0, alpha=0.8)
    ax1.plot(xs, seg['bb_lower'], color='#00bcd4', lw=1.0, alpha=0.8)
    ax1.fill_between(xs, seg['bb_lower'], seg['bb_upper'], alpha=0.06, color='#00bcd4')

    # ── Linhas do trade ──────────────────────────────────────────────────────
    entry, stop, target = trade['entry'], trade['stop'], trade['target']
    ax1.axhline(entry,  color='#2196F3', lw=1.5, ls='--', label=f"Entrada {entry:.5f}")
    ax1.axhline(stop,   color='#f44336', lw=1.5, ls='--', label=f"Stop {stop:.5f}  (-{trade['risco_pips']:.1f}p)")
    ax1.axhline(target, color='#4caf50', lw=1.5, ls='--', label=f"Alvo {target:.5f}  (+{trade['ganho_pips']:.1f}p)")

    # Sombra de risco/ganho
    ax1.axvspan(rel - 0.5, rel + 0.5, alpha=0.15, color='white')
    cor_dir = '#26a69a' if trade['direction'] == 'COMPRA' else '#ef5350'
    ax1.annotate(
        f"{'▲' if trade['direction'] == 'COMPRA' else '▼'} {trade['direction']}",
        xy=(rel, entry), xytext=(rel + 1, entry),
        color=cor_dir, fontsize=13, fontweight='bold', va='center'
    )

    # ── BB Width (painel inferior) ───────────────────────────────────────────
    ax2.plot(xs, seg['bb_width'], color='#ff9800', lw=1.2)
    ax2.fill_between(xs, 0, seg['bb_width'], alpha=0.25, color='#ff9800')
    ax2.axhline(SQUEEZE_RATIO, color='#9e9e9e', lw=0.8, ls=':', alpha=0.7)
    ax2.axvline(rel, color='white', lw=0.6, alpha=0.35)

    # ── Estilo ───────────────────────────────────────────────────────────────
    for ax in [ax1, ax2]:
        ax.set_facecolor('#0d1117')
        ax.tick_params(colors='#9e9e9e', labelsize=8)
        for spine in ax.spines.values():
            spine.set_color('#333')
        ax.spines['top'].set_visible(False)
        ax.spines['right'].set_visible(False)
        ax.grid(True, alpha=0.08, color='gray')

    ax2.set_ylabel('BB Width', color='#9e9e9e', fontsize=8)
    xticks = list(range(0, len(seg), 10))
    ax2.set_xticks(xticks)
    ax2.set_xticklabels(
        [seg.index[j].strftime('%d/%m %H:%M') for j in xticks],
        rotation=35, ha='right', fontsize=7, color='#9e9e9e'
    )
    ax1.set_xticks([])

    emoji = '🟢' if trade['direction'] == 'COMPRA' else '🔴'
    ax1.set_title(
        f"{emoji}  Trade #{num:02d} — {trade['direction']}  |  "
        f"{trade['time'].strftime('%d/%m/%Y %H:%M')}  |  "
        f"Entrada: {entry:.5f}   Stop: {stop:.5f} ({trade['risco_pips']:.1f} pips)   "
        f"Alvo: {target:.5f} ({trade['ganho_pips']:.1f} pips)   R:R {RR_RATIO}x",
        color='white', fontsize=10, pad=12
    )
    ax1.legend(loc='upper left', fontsize=8, facecolor='#1a1a2e',
               labelcolor='white', framealpha=0.7)

    plt.tight_layout(h_pad=0.5)

    nome = (f"trade_{num:02d}_{trade['direction']}_"
            f"{trade['time'].strftime('%m%d_%H%M')}.png")
    caminho = os.path.join(OUTPUT_DIR, nome)
    plt.savefig(caminho, dpi=110, bbox_inches='tight', facecolor='#0d1117')
    plt.close()
    return caminho


def main():
    df     = baixar_dados(dias=10)
    df     = calcular_indicadores(df)
    trades = detectar_trades(df)

    print(f"\n{len(trades)} rompimentos detectados\n")

    caminhos = []
    for n, trade in enumerate(trades, 1):
        caminho = gerar_print(df, trade, n)
        caminhos.append(caminho)
        sinal = '▲' if trade['direction'] == 'COMPRA' else '▼'
        print(f"  {sinal} #{n:02d} {trade['direction']:6s}  "
              f"{trade['time'].strftime('%d/%m %H:%M')}  "
              f"entrada={trade['entry']:.5f}  "
              f"stop={trade['stop']:.5f}  "
              f"alvo={trade['target']:.5f}  "
              f"→ {caminho}")

    print(f"\n✅ Prints salvos em: {OUTPUT_DIR}")
    return caminhos


if __name__ == "__main__":
    main()
