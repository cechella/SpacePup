/**
 * Extração de features para o XGBoost a partir de rows da rafi_trades.
 * 13 features numéricas — hora com encoding circular para capturar ciclicidade.
 */

export interface TradeFeatures {
  rafi_value:      number  // [0, 5] — valor absoluto do RAFI
  rafi_bucket:     number  // 0=fraco, 1=moderado, 2=forte
  direction:       number  // 0=sell, 1=buy
  hora_utc:        number  // [0, 23]
  sessao:          number  // 0=Overlap, 1=Londres, 2=NY, 3=Ásia
  dia_semana:      number  // [0, 6] — 0=Dom
  bb_width:        number  // largura das Bollinger ~[0.0005, 0.02]
  checkin_sono:    number  // 0=sem checkin, 1=ótimo, 2=ok, 3=mal
  checkin_energia: number  // 0=sem, 1=alta, 2=ok, 3=baixa
  checkin_mental:  number  // 0=sem, 1=focado, 2=ok, 3=ruim
  checkin_humor:   number  // 0=sem, 1=feliz, 2=neutro, 3=triste
  hora_sin:        number  // sin(hora * 2π/24) — ciclicidade
  hora_cos:        number  // cos(hora * 2π/24)
}

export interface TradeRow {
  rafi?:            number | null
  direction:        string
  time:             number
  bb_width?:        number | null
  checkin_sono?:    string | null
  checkin_energia?: string | null
  checkin_mental?:  string | null
  checkin_humor?:   string | null
}

function rafiBucketCode(rafi: number): number {
  if (rafi >= 2.5) return 2
  if (rafi >= 1.0) return 1
  return 0
}

function sessionCode(h: number): number {
  if (h >= 12 && h < 16) return 0  // Overlap
  if (h >= 8  && h < 12) return 1  // Londres
  if (h >= 16 && h < 20) return 2  // NY
  if (h >= 23 || h < 3)  return 3  // Ásia
  return 0
}

function checkinCode(val: string | null | undefined, map: Record<string, number>): number {
  if (!val) return 0
  return map[val] ?? 0
}

export function extractFeatures(row: TradeRow): TradeFeatures {
  const rafi  = Math.min(Math.abs(Number(row.rafi ?? 0)), 5)
  const ts    = Number(row.time) * 1000
  const hora  = new Date(ts).getUTCHours()
  const dia   = new Date(ts).getUTCDay()
  const angle = (hora / 24) * 2 * Math.PI

  return {
    rafi_value:      rafi,
    rafi_bucket:     rafiBucketCode(rafi),
    direction:       row.direction === 'buy' ? 1 : 0,
    hora_utc:        hora,
    sessao:          sessionCode(hora),
    dia_semana:      dia,
    bb_width:        Math.min(Number(row.bb_width ?? 0.002), 0.02),
    checkin_sono:    checkinCode(row.checkin_sono,    { otimo: 1, ok: 2, mal: 3 }),
    checkin_energia: checkinCode(row.checkin_energia, { alta: 1, ok: 2, baixa: 3 }),
    checkin_mental:  checkinCode(row.checkin_mental,  { focado: 1, ok: 2, ruim: 3 }),
    checkin_humor:   checkinCode(row.checkin_humor,   { feliz: 1, neutro: 2, triste: 3 }),
    hora_sin:        Math.sin(angle),
    hora_cos:        Math.cos(angle),
  }
}

export function featuresToArray(f: TradeFeatures): number[] {
  return [
    f.rafi_value, f.rafi_bucket, f.direction,
    f.hora_utc, f.sessao, f.dia_semana,
    f.bb_width,
    f.checkin_sono, f.checkin_energia, f.checkin_mental, f.checkin_humor,
    f.hora_sin, f.hora_cos,
  ]
}

export const FEATURE_NAMES = [
  'rafi_value', 'rafi_bucket', 'direction',
  'hora_utc', 'sessao', 'dia_semana',
  'bb_width',
  'checkin_sono', 'checkin_energia', 'checkin_mental', 'checkin_humor',
  'hora_sin', 'hora_cos',
]
