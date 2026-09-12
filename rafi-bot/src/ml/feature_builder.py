"""
feature_builder.py — Extrai as 12 features de cada sinal de trading

As features capturam o contexto de mercado no momento do sinal:
quem somos nós (sessão, hora, direção), como está o mercado (volatilidade,
squeeze, força do rompimento) e como estamos performando (WR rolling).

O XGBoost usa essas 12 features para aprender QUANDO a estratégia funciona
e quando não funciona — filtrando os sinais ruins antes de abrir trade.
"""

import math
from datetime import timezone

# ── Nomes das features (ordem fixa — nunca mudar após treino) ───────────────
FEATURE_NAMES = [
    'hora_utc',           # 0–23: hora do sinal em UTC
    'sessao',             # 0=Ásia 1=Londres 2=NY 3=Overlap Londres/NY
    'dia_semana',         # 0=Segunda … 4=Sexta
    'forca_rompimento',   # pips além do S/R (strength do breakout)
    'squeeze_ratio',      # largura BB / preço mid no candle do sinal
    'expansao_bb',        # expansão BB vs candle anterior (ratio)
    'atr14',              # ATR 14 candles em pips (volatilidade)
    'dist_topo_pips',     # distância do último topo em pips
    'dist_fundo_pips',    # distância do último fundo em pips
    'direcao',            # +1 = compra | -1 = venda
    'wr_rolling20',       # win rate dos últimos 20 trades (0.5 se sem histórico)
    'rr_ratio',           # razão risco/retorno configurada
]

N_FEATURES = len(FEATURE_NAMES)  # 12


def sessao_do_horario(hora_utc: int) -> int:
    """
    Classifica a sessão com base na hora UTC.
    Overlap Londres/NY (12–17h) é a mais lucrativa — sessão 3.
    """
    if 12 <= hora_utc < 17:
        return 3   # Overlap — maior liquidez
    elif 7 <= hora_utc < 17:
        return 1   # Londres
    elif 17 <= hora_utc < 22:
        return 2   # Nova York
    else:
        return 0   # Ásia


def calcular_atr(candles: list, periodo: int = 14) -> float:
    """ATR simples: média dos true ranges dos últimos N candles."""
    if len(candles) < 2:
        return 0.001  # fallback 10 pips
    trs = []
    for i in range(1, min(periodo + 1, len(candles))):
        c = candles[-i]
        p = candles[-(i + 1)]
        tr = max(
            c['high'] - c['low'],
            abs(c['high'] - p['close']),
            abs(c['low']  - p['close']),
        )
        trs.append(tr)
    return sum(trs) / len(trs) if trs else 0.001


def calcular_bb(candles: list, periodo: int = 10, desvios: float = 2.0):
    """Retorna (upper, mid, lower) das Bandas de Bollinger."""
    if len(candles) < periodo:
        closes = [c['close'] for c in candles]
    else:
        closes = [c['close'] for c in candles[-periodo:]]
    mid = sum(closes) / len(closes)
    if len(closes) < 2:
        return mid + 0.001, mid, mid - 0.001
    var = sum((x - mid) ** 2 for x in closes) / len(closes)
    std = math.sqrt(var)
    return mid + desvios * std, mid, mid - desvios * std


def extrair_features(
    candles_ate_sinal: list,   # candles M5 até e incluindo o candle do sinal
    direcao: int,              # +1 compra | -1 venda
    forca_rompimento: float,   # pips além do S/R (ex: 0.00005 = 5 pips)
    rr_ratio: float,           # R:R configurado (ex: 1.3)
    sr_lookback: int = 15,     # lookback para topo/fundo
    bb_periodo: int = 10,
    wr_rolling20: float = 0.5, # 0.5 = neutro (sem histórico ainda)
) -> list:
    """
    Retorna lista de 12 features para um sinal.

    Parâmetros:
        candles_ate_sinal : lista de dicts {time, open, high, low, close}
                            ordenada cronologicamente; o último é o candle do sinal
        direcao           : +1 (compra) ou -1 (venda)
        forca_rompimento  : distância do fechamento ao nível S/R em preço
        rr_ratio          : razão risco/retorno
        sr_lookback       : janela para calcular topo/fundo recente
        bb_periodo        : período das Bandas de Bollinger
        wr_rolling20      : WR dos últimos 20 trades (0.5 = sem dados)
    """
    if not candles_ate_sinal:
        return [0.0] * N_FEATURES

    candle = candles_ate_sinal[-1]

    # ── 1. Hora e sessão ────────────────────────────────────────────────────
    import datetime as _dt
    ts = candle.get('time', 0)
    dt = _dt.datetime.fromtimestamp(ts, tz=timezone.utc) if ts else _dt.datetime.utcnow()
    hora_utc  = dt.hour
    sessao    = sessao_do_horario(hora_utc)
    dia_semana = dt.weekday()  # 0=segunda, 4=sexta

    # ── 2. Força do rompimento em pips ──────────────────────────────────────
    forca_pips = round(forca_rompimento / 0.00001)  # converte preço → pips

    # ── 3. Bollinger Bands — squeeze e expansão ─────────────────────────────
    upper_now, mid_now, lower_now = calcular_bb(candles_ate_sinal, bb_periodo)
    squeeze_now = (upper_now - lower_now) / mid_now if mid_now else 0.0

    # expansão vs candle anterior
    if len(candles_ate_sinal) >= 2:
        upper_ant, mid_ant, lower_ant = calcular_bb(candles_ate_sinal[:-1], bb_periodo)
        squeeze_ant = (upper_ant - lower_ant) / mid_ant if mid_ant else squeeze_now
        expansao_bb = squeeze_now / squeeze_ant if squeeze_ant > 0 else 1.0
    else:
        expansao_bb = 1.0

    # ── 4. ATR em pips ──────────────────────────────────────────────────────
    atr_preco = calcular_atr(candles_ate_sinal, 14)
    atr_pips  = round(atr_preco / 0.00001)

    # ── 5. Distância do topo e fundo recentes ───────────────────────────────
    janela = candles_ate_sinal[-sr_lookback:] if len(candles_ate_sinal) >= sr_lookback else candles_ate_sinal
    topo   = max(c['high']  for c in janela)
    fundo  = min(c['low']   for c in janela)
    close  = candle['close']
    dist_topo  = round(abs(topo  - close) / 0.00001)
    dist_fundo = round(abs(close - fundo) / 0.00001)

    return [
        float(hora_utc),
        float(sessao),
        float(dia_semana),
        float(forca_pips),
        float(squeeze_now),
        float(expansao_bb),
        float(atr_pips),
        float(dist_topo),
        float(dist_fundo),
        float(direcao),
        float(wr_rolling20),
        float(rr_ratio),
    ]
