// Tiers de escalonamento de lote — dobra conforme o capital cresce
export const SCALE_TIERS = [
  { minCap: 0,        lot: 0.20  },
  { minCap: 150,      lot: 0.40  },
  { minCap: 200,      lot: 0.80  },
  { minCap: 300,      lot: 1.00  },
  { minCap: 600,      lot: 2.00  },
  { minCap: 1_200,    lot: 4.00  },
  { minCap: 2_500,    lot: 8.00  },
  { minCap: 5_000,    lot: 15.00 },
  { minCap: 10_000,   lot: 30.00 },
  { minCap: 25_000,   lot: 60.00 },
  { minCap: 50_000,   lot: 120.00 },
  { minCap: 100_000,  lot: 250.00 },
  { minCap: 200_000,  lot: 500.00 },
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
