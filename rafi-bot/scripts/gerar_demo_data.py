"""
gerar_demo_data.py — Replica os candles demo do browser (seed 1337, Jan 6-10 2025)

O browser usa generateDemoData('M5') com PRNG Mulberry32, seed 1337.
Este script replica o algoritmo JavaScript bit-a-bit para gerar dados idênticos.

Uso:
  python scripts/gerar_demo_data.py --out data/EURUSD_demo_jan2025.csv
"""

import ctypes
import math
import argparse
import pandas as pd
from datetime import datetime, timezone


# ── PRNG Mulberry32 — réplica exata do JavaScript ────────────────────────────

def _to_int32(x: int) -> int:
    """Equivalente ao operador |0 do JavaScript (ToInt32 — trunca para signed int32)."""
    return ctypes.c_int32(x & 0xFFFFFFFF).value


def _imul(a: int, b: int) -> int:
    """Equivalente ao Math.imul do JavaScript (multiplicação int32 com overflow)."""
    return _to_int32(_to_int32(a) * _to_int32(b))


def _urshift(x: int, n: int) -> int:
    """Equivalente ao >>> do JavaScript (unsigned right shift, zero-fill)."""
    return (x & 0xFFFFFFFF) >> n


def mulberry32(seed: int):
    """
    PRNG determinístico Mulberry32 — mesma seed = mesma sequência que o browser.

    Réplica exata de:
      function mulberry32(seed) {
        return () => {
          seed |= 0; seed = (seed + 0x6D2B79F5) | 0
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296
        }
      }
    """
    state = [_to_int32(seed)]   # seed |= 0 na inicialização

    def rand() -> float:
        s = _to_int32(state[0] + 0x6D2B79F5)   # seed = (seed + 0x6D2B79F5) | 0
        state[0] = s
        t = _imul(s ^ _urshift(s, 15), 1 | s)
        t = (t + _imul(t ^ _urshift(t, 7), 61 | t)) ^ t
        return _urshift(t ^ _urshift(t, 14), 0) / 4294967296   # >>> 0 = uint32

    return rand


# ── Gerador de candles — réplica de generateDemoData('M5') ───────────────────

def gerar_demo_m5() -> pd.DataFrame:
    """
    Replica generateDemoData('M5') do arquivo rafi-dashboard/lib/demo-data.ts.

    Parâmetros fixos (hardcoded no browser):
      seed=1337, startTs=1736121600, close_inicial=1.03050, tf=M5, 5 dias (Seg-Sex)
    """
    rand            = mulberry32(1337)
    interval_sec    = 300          # M5 = 5 minutos
    mult            = 1.0          # intervalSec / 300
    candles_per_day = 288          # 86400 / 300
    start_ts        = 1736121600   # Segunda 6 jan 2025, 00:00 UTC

    def get_drift(js_dow: int, hour: int) -> float:
        """Perfil de drift por dia/hora — réplica exata do getDrift() JS."""
        base = 0.0
        if js_dow == 1:      # Segunda
            if 7 <= hour < 12:    base =  0.000012
            elif 12 <= hour < 17: base = -0.000005
            else:                 base =  0.000002
        elif js_dow == 2:    # Terça
            if 7 <= hour < 10:    base =  0.000020
            elif 10 <= hour < 15: base =  0.000018
            elif 15 <= hour < 20: base =  0.000008
            else:                 base =  0.000003
        elif js_dow == 3:    # Quarta
            if 7 <= hour < 12:    base = -0.000025
            elif 12 <= hour < 17: base = -0.000018
            elif 17 <= hour < 22: base = -0.000010
            else:                 base = -0.000003
        elif js_dow == 4:    # Quinta
            if 8 <= hour < 13:    base =  0.000015
            elif 13 <= hour < 18: base =  0.000010
            else:                 base =  0.000002
        elif js_dow == 5:    # Sexta
            if 9 <= hour < 14:    base = -0.000008
            else:                 base =  0.000001
        return base * mult

    def get_vol(hour: int) -> float:
        """Volatilidade por sessão — réplica exata do getVol() JS."""
        base = 0.00012
        if 7 <= hour < 12:    base = 0.00028
        elif 12 <= hour < 17: base = 0.00024
        elif 17 <= hour < 22: base = 0.00018
        return base * math.sqrt(mult)

    def r5(x: float) -> float:
        """Math.round(x * 100000) / 100000 — arredonda para 5 casas decimais."""
        return round(x * 100000) / 100000

    close = 1.03050
    rows  = []

    for d in range(5):
        day_ts = start_ts + d * 86400
        for c in range(candles_per_day):
            ts = day_ts + c * interval_sec
            dt = datetime.fromtimestamp(ts, tz=timezone.utc)

            # JS: getUTCDay() → Sun=0, Mon=1, ..., Sat=6
            # Python isoweekday(): Mon=1, ..., Sun=7 → % 7 dá Sun=0, Mon=1, ..., Sat=6
            js_dow = dt.isoweekday() % 7

            if js_dow == 0 or js_dow == 6:   # skip fim de semana
                continue

            hour  = dt.hour
            vol   = get_vol(hour)
            drift = get_drift(js_dow, hour)

            open_ = close
            noise = (rand() - 0.5) * 2 * vol
            close = open_ + drift + noise

            body_high = max(open_, close)
            body_low  = min(open_, close)
            high   = body_high + rand() * vol * 0.6
            low    = body_low  - rand() * vol * 0.6
            volume = int(800 + rand() * 3500)

            rows.append({
                'datetime': dt,
                'open':     r5(open_),
                'high':     r5(high),
                'low':      r5(low),
                'close':    r5(close),
                'volume':   float(volume),
            })

    df = pd.DataFrame(rows).set_index('datetime')
    return df


# ── Ponto de entrada ──────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description='Gera candles demo idênticos ao browser (seed 1337, Jan 6-10 2025)'
    )
    parser.add_argument('--out', default='data/EURUSD_demo_jan2025.csv',
                        help='Caminho de saída do CSV (padrão: data/EURUSD_demo_jan2025.csv)')
    args = parser.parse_args()

    print("Gerando candles demo (réplica do browser)...")
    df = gerar_demo_m5()
    df.to_csv(args.out)

    print(f"✔  {len(df)} candles salvos em: {args.out}")
    print(f"   Período : {df.index[0]}  →  {df.index[-1]}")
    print(f"   Preço   : {df['open'].iloc[0]:.5f} (abertura)  →  {df['close'].iloc[-1]:.5f} (fechamento)")
    print(f"   Range   : {df['low'].min():.5f} — {df['high'].max():.5f}")


if __name__ == '__main__':
    main()
