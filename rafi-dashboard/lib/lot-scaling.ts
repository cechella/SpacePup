// Tiers de escalonamento — espelha rafi_lote_faixas no Supabase
// Fonte primária: Supabase (admin /config). Este arquivo é usado pelo dashboard
// para cálculos offline. Manter em sincronia com o Supabase.
export const SCALE_TIERS = [
  { minCap: 0,       lot: 0.10  },
  { minCap: 20,      lot: 0.20  },
  { minCap: 50,      lot: 0.50  },
  { minCap: 100,     lot: 1.00  },
  { minCap: 200,     lot: 2.00  },
  { minCap: 500,     lot: 4.00  },
  { minCap: 1_000,   lot: 8.00  },
  { minCap: 2_000,   lot: 16.00 },
  { minCap: 5_000,   lot: 30.00 },
  { minCap: 10_000,  lot: 60.00 },
  { minCap: 20_000,  lot: 100.00 },
  { minCap: 50_000,  lot: 100.00 },
]

export const SCALE_TIER_LABELS = [
  '$0–20', '$20–50', '$50–100', '$100–200', '$200–500',
  '$500–1k', '$1k–2k', '$2k–5k', '$5k–10k', '$10k–20k', '$20k–50k', '$50k+',
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
