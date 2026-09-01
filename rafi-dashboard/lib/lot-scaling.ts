// Tiers de escalonamento agressivo — 15% de risco por trade (XM 1:1000)
// 0.1L = $1/pip; capital mínimo = stop(3p) / 0.15
export const SCALE_TIERS = [
  { minCap: 0,        lot: 0.10  },
  { minCap: 40,       lot: 0.20  },
  { minCap: 80,       lot: 0.40  },
  { minCap: 150,      lot: 0.70  },
  { minCap: 200,      lot: 1.00  },
  { minCap: 400,      lot: 2.00  },
  { minCap: 800,      lot: 4.00  },
  { minCap: 1_500,    lot: 8.00  },
  { minCap: 3_000,    lot: 15.00 },
  { minCap: 6_000,    lot: 30.00 },
  { minCap: 10_000,   lot: 50.00 },
  { minCap: 20_000,   lot: 100.00 },
]

export function getLotForCapital(capital: number): number {
  let lot = SCALE_TIERS[0].lot
  for (const t of SCALE_TIERS) { if (capital >= t.minCap) lot = t.lot }
  return lot
}

export function getNextTier(capital: number): { minCap: number; lot: number } | null {
  for (let i = 0; i < SCALE_TIERS.length - 1; i++) {
    if (capital >= SCALE_TIERS[i].minCap && capital < SCALE_TIERS[i + 1].minCap) {
      return SCALE_TIERS[i + 1]
    }
  }
  return null
}

// Calcula capital atual: base + P&L dos trades rotulados
export function calcCapital(
  trades: { entry: number; stopLoss: number; takeProfit: number; direction: 'buy' | 'sell'; lot: number; result?: string }[],
  baseCapital = 100,
): number {
  let c = baseCapital
  for (const t of trades) {
    if (t.result === 'win') {
      const pips = t.direction === 'buy'
        ? Math.round((t.takeProfit - t.entry) * 10000)
        : Math.round((t.entry - t.takeProfit) * 10000)
      c += pips * t.lot * 10
    } else if (t.result === 'loss') {
      const pips = t.direction === 'buy'
        ? Math.round((t.entry - t.stopLoss) * 10000)
        : Math.round((t.stopLoss - t.entry) * 10000)
      c -= pips * t.lot * 10
    }
  }
  return Math.max(0, c)
}
