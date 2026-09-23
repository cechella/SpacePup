'use client'

import { useEffect, useRef, useState } from 'react'

// ─── Dados das sessões Forex (horários UTC) ─────────────────────────────────
const SESS = [
  { key: 's', cls: 'cs', color: '#10b981', name: 'Sydney',    flag: '🇦🇺', tz: 'Australia/Sydney',  oH: 22, oM: 0, cH: 7,  cM: 0, wrap: true  },
  { key: 't', cls: 'ct', color: '#38bdf8', name: 'Tóquio',    flag: '🇯🇵', tz: 'Asia/Tokyo',         oH: 23, oM: 0, cH: 8,  cM: 0, wrap: true  },
  { key: 'l', cls: 'cl', color: '#f59e0b', name: 'Londres',   flag: '🇬🇧', tz: 'Europe/London',      oH: 8,  oM: 0, cH: 17, cM: 0, wrap: false },
  { key: 'n', cls: 'cn', color: '#8b5cf6', name: 'Nova York', flag: '🇺🇸', tz: 'America/New_York',   oH: 13, oM: 0, cH: 22, cM: 0, wrap: false },
] as const

// ─── Janelas da IA RAFI (sobreposições de sessões) ──────────────────────────
const IA_W = [
  { name: 'Sydney × Tóquio',  sH: 23, sM: 0, eH: 7,  eM: 0, wrap: true,  cron: '02:00' },
  { name: 'Tóquio × Londres', sH: 7,  sM: 0, eH: 8,  eM: 0, wrap: false, cron: '07:00' },
  { name: 'Londres × NY',     sH: 12, sM: 0, eH: 16, eM: 0, wrap: false, cron: '14:00' },
] as const

// ─── Segmentos estáticos da timeline 24h ────────────────────────────────────
const TL_SEGS = [
  { s: 22, e: 24, c: '#10b981', o: 0.38 }, { s: 0, e: 7,  c: '#10b981', o: 0.38 },
  { s: 23, e: 24, c: '#38bdf8', o: 0.38 }, { s: 0, e: 8, c: '#38bdf8', o: 0.38 },
  { s: 8,  e: 17, c: '#f59e0b', o: 0.38 },
  { s: 13, e: 22, c: '#8b5cf6', o: 0.38 },
]
const TL_IA = [
  { s: 23, e: 24 }, { s: 0, e: 7 }, { s: 7, e: 8 }, { s: 12, e: 16 },
]

// ─── Helpers ────────────────────────────────────────────────────────────────
function utcMin(d: Date) { return d.getUTCHours() * 60 + d.getUTCMinutes() + d.getUTCSeconds() / 60 }

function isOpen(s: typeof SESS[number], now: Date) {
  const c = utcMin(now), o = s.oH * 60 + s.oM, cl = s.cH * 60 + s.cM
  return s.wrap ? c >= o || c < cl : c >= o && c < cl
}

function iaOpen(w: typeof IA_W[number], now: Date) {
  const c = utcMin(now), st = w.sH * 60 + w.sM, e = w.eH * 60 + w.eM
  return w.wrap ? c >= st || c < e : c >= st && c < e
}

function fmtDuration(m: number) {
  m = Math.max(0, Math.ceil(m))
  if (m < 60) return `${m}m`
  return `${Math.floor(m / 60)}h${m % 60 > 0 ? ` ${m % 60}m` : ''}`
}

function getTimeParts(date: Date, tz: string) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(date)
  const h = parseInt(p.find(x => x.type === 'hour')!.value) % 24
  const m = parseInt(p.find(x => x.type === 'minute')!.value)
  const s = parseInt(p.find(x => x.type === 'second')!.value)
  return { h, m, s }
}

function getShortTZ(date: Date, tz: string) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
      .formatToParts(date).find(p => p.type === 'timeZoneName')?.value ?? ''
  } catch { return '' }
}

function pad2(n: number) { return String(n).padStart(2, '0') }

// ─── SVG do relógio analógico ────────────────────────────────────────────────
function makeSVG(key: string, color: string) {
  const CX = 100, CY = 100, R = 92
  let ticks = ''
  for (let i = 0; i < 60; i++) {
    const a = (i * 6 - 90) * Math.PI / 180
    const isH = i % 5 === 0
    const r1 = R - (isH ? 13 : 6), r2 = R - 1
    const x1 = CX + r1 * Math.cos(a), y1 = CY + r1 * Math.sin(a)
    const x2 = CX + r2 * Math.cos(a), y2 = CY + r2 * Math.sin(a)
    ticks += `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${isH ? 'rgba(255,255,255,.45)' : 'rgba(255,255,255,.12)'}" stroke-width="${isH ? 2 : 1}" stroke-linecap="round"/>`
  }
  let nums = ''
  const numPos: [number, number][] = [[12, 0], [3, 90], [6, 180], [9, 270]]
  for (const [n, deg] of numPos) {
    const a = (deg - 90) * Math.PI / 180, nr = R - 24
    const nx = CX + nr * Math.cos(a), ny = CY + nr * Math.sin(a)
    nums += `<text x="${nx.toFixed(1)}" y="${ny.toFixed(1)}" text-anchor="middle" dominant-baseline="central" fill="rgba(255,255,255,.3)" font-size="11" font-family="monospace" font-weight="700">${n}</text>`
  }
  return `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:148px;display:block">
  <defs>
    <radialGradient id="fg-${key}" cx="38%" cy="32%" r="70%">
      <stop offset="0%" stop-color="#11243a"/>
      <stop offset="100%" stop-color="#060e1a"/>
    </radialGradient>
    <filter id="gsh-${key}" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="3.5" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <filter id="gs2-${key}" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur in="SourceGraphic" stdDeviation="2" result="b"/>
      <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <circle cx="${CX}" cy="${CY}" r="98" fill="none" stroke="${color}" stroke-width=".8" opacity=".12" id="ro-${key}"/>
  <circle cx="${CX}" cy="${CY}" r="95" fill="none" stroke="${color}" stroke-width="2.5" opacity="0" id="ra-${key}" filter="url(#gsh-${key})"/>
  <circle cx="${CX}" cy="${CY}" r="${R}" fill="url(#fg-${key})"/>
  <circle cx="${CX}" cy="${CY}" r="${R}" fill="none" stroke="rgba(255,255,255,.06)" stroke-width="1"/>
  <circle cx="${CX}" cy="${CY}" r="72" fill="none" stroke="rgba(255,255,255,.025)" stroke-width="1"/>
  ${ticks}${nums}
  <g id="hH-${key}" transform="rotate(0,${CX},${CY})">
    <line x1="${CX}" y1="${CY + 10}" x2="${CX}" y2="${CY - 48}" stroke="rgba(255,255,255,.92)" stroke-width="4.5" stroke-linecap="round"/>
  </g>
  <g id="hM-${key}" transform="rotate(0,${CX},${CY})">
    <line x1="${CX}" y1="${CY + 13}" x2="${CX}" y2="${CY - 64}" stroke="rgba(255,255,255,.82)" stroke-width="2.5" stroke-linecap="round"/>
  </g>
  <g id="hS-${key}" transform="rotate(0,${CX},${CY})" filter="url(#gs2-${key})">
    <line x1="${CX}" y1="${CY + 18}" x2="${CX}" y2="${CY - 70}" stroke="${color}" stroke-width="1.5" stroke-linecap="round"/>
  </g>
  <circle cx="${CX}" cy="${CY}" r="5.5" fill="#0e1f34"/>
  <circle cx="${CX}" cy="${CY}" r="3.5" fill="${color}" filter="url(#gs2-${key})"/>
  <circle cx="${CX}" cy="${CY}" r="1.8" fill="white"/>
</svg>`
}

// ─── Componente principal ────────────────────────────────────────────────────
export function ForexClocks() {
  const rootRef = useRef<HTMLDivElement>(null)
  const [utcStr, setUtcStr] = useState('--:--:--')
  const [mounted, setMounted] = useState(false)

  // Injeta os SVGs estáticos na montagem
  useEffect(() => {
    setMounted(true)
    for (const s of SESS) {
      const el = document.getElementById(`fc-svgw-${s.key}`)
      if (el) el.innerHTML = makeSVG(s.key, s.color)
    }
  }, [])

  // Loop de tick a cada segundo
  useEffect(() => {
    if (!mounted) return

    function tick() {
      const now = new Date()

      // UTC header
      setUtcStr(`${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())}:${pad2(now.getUTCSeconds())}`)

      // Agulha da timeline
      const pct = (utcMin(now) / 1440 * 100).toFixed(3)
      const needle = document.getElementById('fc-tl-needle')
      if (needle) needle.style.left = `${pct}%`

      const tlBadge = document.getElementById('fc-tl-badge')
      if (tlBadge) tlBadge.textContent = `${pad2(now.getUTCHours())}:${pad2(now.getUTCMinutes())} UTC`

      // Cada relógio
      for (const s of SESS) {
        const open = isOpen(s, now)

        const card = document.getElementById(`fc-card-${s.key}`)
        if (card) {
          card.dataset.open = open ? '1' : '0'
          // glow via inline style
          if (open) {
            card.style.borderColor = `${s.color}88`
            card.style.boxShadow = `0 0 28px ${s.color}2e`
          } else {
            card.style.borderColor = '#162436'
            card.style.boxShadow = 'none'
          }
        }

        // Ponteiros SVG
        const { h, m, s: sec } = getTimeParts(now, s.tz)
        const hA = (h % 12) * 30 + m * 0.5 + sec * (0.5 / 60)
        const mA = m * 6 + sec * 0.1
        const sA = sec * 6
        document.getElementById(`hH-${s.key}`)?.setAttribute('transform', `rotate(${hA.toFixed(3)},100,100)`)
        document.getElementById(`hM-${s.key}`)?.setAttribute('transform', `rotate(${mA.toFixed(3)},100,100)`)
        document.getElementById(`hS-${s.key}`)?.setAttribute('transform', `rotate(${sA.toFixed(3)},100,100)`)

        // Halo SVG
        document.getElementById(`ra-${s.key}`)?.setAttribute('opacity', open ? '0.65' : '0')
        document.getElementById(`ro-${s.key}`)?.setAttribute('opacity', open ? '0.35' : '0.1')

        // Hora digital
        const dig = document.getElementById(`fc-dig-${s.key}`)
        if (dig) {
          dig.textContent = `${pad2(h)}:${pad2(m)}:${pad2(sec)}`
          dig.style.color = open ? s.color : '#7fa4c4'
        }

        // Label de fuso
        const tzEl = document.getElementById(`fc-tz-${s.key}`)
        if (tzEl) tzEl.textContent = getShortTZ(now, s.tz)

        // Badge ABERTA / FECHADA
        const badge = document.getElementById(`fc-badge-${s.key}`)
        if (badge) {
          badge.className = open ? `fc-badge fc-badge-open fc-badge-${s.key}` : 'fc-badge fc-badge-closed'
          badge.innerHTML = `<span class="fc-bdot"></span>${open ? 'ABERTA' : 'FECHADA'}`
        }

        // ETA
        const eta = document.getElementById(`fc-eta-${s.key}`)
        if (eta) {
          const c = utcMin(now)
          if (open) {
            let cl = s.cH * 60 + s.cM
            let diff = cl - c; if (diff < 0) diff += 1440
            eta.textContent = `Fecha em ${fmtDuration(diff)}`
          } else {
            let op = s.oH * 60 + s.oM
            let diff = op - c; if (diff < 0) diff += 1440
            eta.textContent = `Abre em ${fmtDuration(diff)}`
          }
        }
      }

      // Chips de sobreposição
      const sO = isOpen(SESS[0], now), tO = isOpen(SESS[1], now)
      const lO = isOpen(SESS[2], now), nO = isOpen(SESS[3], now)
      const overlapST = sO && tO, overlapTL = tO && lO, overlapLN = lO && nO
      const iaAny = IA_W.some(w => iaOpen(w, now))

      const chips = document.getElementById('fc-chips')
      if (chips) {
        const mkChip = (key: string, label: string, on: boolean) =>
          `<div class="fc-chip fc-chip-${key}${on ? ' fc-chip-on' : ' fc-chip-off'}">` +
          `<span class="fc-cdot"></span>${label}</div>`
        chips.innerHTML =
          mkChip('syd', 'Sydney × Tóquio',  overlapST) +
          mkChip('tok', 'Tóquio × Londres', overlapTL) +
          mkChip('lon', 'Londres × NY',      overlapLN) +
          mkChip('ia',  iaAny ? 'IA operando' : 'IA RAFI', iaAny)
      }

      // Painel IA
      const iaSub = document.getElementById('fc-ia-sub')
      if (iaSub) {
        const cur = IA_W.find(w => iaOpen(w, now))
        if (cur) {
          iaSub.textContent = `Operando agora · ${cur.name} (scan ${cur.cron} UTC)`
          iaSub.style.color = '#ec4899'
        } else {
          const c = utcMin(now)
          let bestD = Infinity, bestW: (typeof IA_W)[number] = IA_W[0]
          for (const w of IA_W) {
            let st = w.sH * 60 + w.sM, d = st - c; if (d < 0) d += 1440
            if (d < bestD) { bestD = d; bestW = w }
          }
          iaSub.textContent = `Próximo scan em ${fmtDuration(bestD)} · ${bestW.name}`
          iaSub.style.color = '#4a6a88'
        }
      }

      const iaWin = document.getElementById('fc-ia-windows')
      if (iaWin) {
        iaWin.innerHTML = IA_W.map(w => {
          const on = iaOpen(w, now)
          return `<div class="fc-iawin${on ? ' fc-iawin-on' : ' fc-iawin-off'}">` +
            `<span class="fc-iawin-dot"></span>${w.name}</div>`
        }).join('')
      }
    }

    tick()
    const id = setInterval(tick, 1000)
    return () => clearInterval(id)
  }, [mounted])

  // ─── Markup estático ─────────────────────────────────────────────────────
  return (
    <div ref={rootRef} style={{ fontFamily: "'Space Grotesk', system-ui, sans-serif", color: '#ddeeff' }}>
      <style>{`
        .fc-section {
          background: #0b1828; border: 1px solid #19304a;
          border-radius: 12px; padding: 14px 16px;
        }
        /* ── Header ── */
        .fc-header {
          display: flex; align-items: flex-end; justify-content: space-between;
          flex-wrap: wrap; gap: 8px; margin-bottom: 12px;
        }
        .fc-header-small { display: block; font-size: .6rem; color: #4a6a88; letter-spacing: .14em; text-transform: uppercase; margin-bottom: 3px; }
        .fc-header-h1 { font-size: 1rem; font-weight: 600; color: #7fa4c4; letter-spacing: .06em; text-transform: uppercase; }
        .fc-utc-label { font-size: .6rem; color: #4a6a88; letter-spacing: .14em; text-transform: uppercase; text-align: right; }
        .fc-utc-time { font-family: 'Space Mono', monospace; font-size: 1.6rem; font-weight: 700; color: #ddeeff; letter-spacing: .04em; line-height: 1; text-align: right; }
        /* ── Banner chips ── */
        .fc-banner {
          background: #0b1828; border: 1px solid #19304a;
          border-radius: 10px; padding: 9px 14px;
          display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 12px;
        }
        .fc-banner-label { font-size: .6rem; color: #4a6a88; letter-spacing: .12em; text-transform: uppercase; font-weight: 600; white-space: nowrap; }
        .fc-chips { display: flex; gap: 7px; flex-wrap: wrap; }
        .fc-chip { display: flex; align-items: center; gap: 5px; padding: 3px 10px; border-radius: 20px; font-size: .72rem; font-weight: 600; letter-spacing: .03em; border: 1px solid transparent; transition: opacity .3s; }
        .fc-cdot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
        .fc-chip-on .fc-cdot { animation: fc-blink 1.6s ease-in-out infinite; }
        @keyframes fc-blink { 0%,100%{opacity:1} 50%{opacity:.25} }
        .fc-chip-syd { background: rgba(16,185,129,.12); border-color: rgba(16,185,129,.3) !important; color: #10b981; }
        .fc-chip-tok { background: rgba(56,189,248,.12); border-color: rgba(56,189,248,.3) !important; color: #38bdf8; }
        .fc-chip-lon { background: rgba(245,158,11,.12); border-color: rgba(245,158,11,.3) !important; color: #f59e0b; }
        .fc-chip-ia  { background: rgba(236,72,153,.12); border-color: rgba(236,72,153,.3) !important; color: #ec4899; }
        .fc-chip-off { background: rgba(255,255,255,.04) !important; border-color: rgba(255,255,255,.07) !important; color: #4a6a88 !important; }
        /* ── Clocks grid ── */
        .fc-grid {
          display: grid; grid-template-columns: repeat(4,1fr); gap: 12px; margin-bottom: 12px;
        }
        @media (max-width: 640px) { .fc-grid { grid-template-columns: repeat(2,1fr); } }
        .fc-card {
          background: #0e1f34; border: 1px solid #162436;
          border-radius: 16px; padding: 14px 10px 12px;
          display: flex; flex-direction: column; align-items: center; gap: 8px;
          transition: border-color .5s, box-shadow .5s; position: relative; overflow: hidden;
        }
        .fc-city { display: flex; align-items: center; gap: 5px; font-size: .72rem; font-weight: 600; color: #7fa4c4; letter-spacing: .08em; text-transform: uppercase; }
        .fc-flag { font-size: .9rem; line-height: 1; }
        .fc-digital { font-family: 'Space Mono', monospace; font-size: .9rem; font-weight: 700; letter-spacing: .06em; color: #ddeeff; transition: color .4s; }
        .fc-tz { font-size: .6rem; color: #4a6a88; letter-spacing: .07em; text-transform: uppercase; margin-top: -4px; }
        .fc-eta { font-size: .63rem; color: #4a6a88; letter-spacing: .03em; text-align: center; min-height: 1em; }
        /* ── Badge ── */
        .fc-badge { display: flex; align-items: center; gap: 4px; padding: 3px 9px; border-radius: 20px; font-size: .65rem; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; }
        .fc-badge-closed { background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08); color: #4a6a88; }
        .fc-badge-open { border: 1px solid transparent; }
        .fc-badge-s.fc-badge-open { background: rgba(16,185,129,.15); border-color: rgba(16,185,129,.3) !important; color: #10b981; }
        .fc-badge-t.fc-badge-open { background: rgba(56,189,248,.15); border-color: rgba(56,189,248,.3) !important; color: #38bdf8; }
        .fc-badge-l.fc-badge-open { background: rgba(245,158,11,.15); border-color: rgba(245,158,11,.3) !important; color: #f59e0b; }
        .fc-badge-n.fc-badge-open { background: rgba(139,92,246,.15); border-color: rgba(139,92,246,.3) !important; color: #8b5cf6; }
        .fc-bdot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
        .fc-badge-open .fc-bdot { animation: fc-blink 1.4s ease-in-out infinite; }
        /* ── Timeline ── */
        .fc-tl-wrap { position: relative; margin-bottom: 6px; }
        .fc-tl-bar { height: 24px; background: rgba(255,255,255,.04); border-radius: 4px; overflow: hidden; position: relative; }
        .fc-tl-seg { position: absolute; top: 0; height: 100%; border-radius: 2px; }
        .fc-tl-ia { position: absolute; top: 2px; height: calc(100% - 4px);
          background: repeating-linear-gradient(-45deg,rgba(236,72,153,.3) 0,rgba(236,72,153,.3) 3px,transparent 3px,transparent 8px);
          border-top: 1px solid rgba(236,72,153,.55); border-bottom: 1px solid rgba(236,72,153,.55); }
        .fc-tl-needle { position: absolute; top: -5px; width: 2px; height: 34px; background: white; border-radius: 1px; transform: translateX(-50%); box-shadow: 0 0 10px rgba(255,255,255,.9); z-index: 10; pointer-events: none; }
        .fc-tl-needle::before { content:''; position:absolute; top:-3px; left:50%; transform:translateX(-50%); width:8px; height:8px; border-radius:50%; background:white; box-shadow:0 0 10px white; }
        .fc-tl-labels { display:flex; justify-content:space-between; margin-top:5px; }
        .fc-tl-lbl { font-family:'Space Mono',monospace; font-size:.58rem; color:#4a6a88; }
        .fc-tl-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:12px; }
        .fc-tl-title { font-size:.65rem; color:#4a6a88; letter-spacing:.12em; text-transform:uppercase; font-weight:600; }
        .fc-tl-badge { font-family:'Space Mono',monospace; font-size:.65rem; color:#4a6a88; background:rgba(255,255,255,.04); padding:2px 8px; border-radius:6px; border:1px solid rgba(255,255,255,.07); }
        .fc-tl-legend { display:flex; gap:14px; flex-wrap:wrap; margin-top:10px; }
        .fc-tl-leg-item { display:flex; align-items:center; gap:5px; font-size:.68rem; color:#7fa4c4; }
        .fc-tl-leg-sw { width:10px; height:10px; border-radius:2px; }
        /* ── IA Panel ── */
        .fc-ia-panel {
          background: #0b1828; border: 1px solid rgba(236,72,153,.22);
          border-radius: 12px; padding: 12px 16px;
          display: flex; align-items: center; justify-content: space-between;
          flex-wrap: wrap; gap: 12px; margin-top: 12px;
        }
        .fc-ia-left { display:flex; align-items:center; gap:10px; }
        .fc-ia-icon { width:36px; height:36px; flex-shrink:0; background:rgba(236,72,153,.1); border:1px solid rgba(236,72,153,.3); border-radius:10px; display:flex; align-items:center; justify-content:center; font-size:1.1rem; }
        .fc-ia-title { font-size:.8rem; font-weight:600; color:#ddeeff; margin-bottom:2px; }
        .fc-ia-sub { font-size:.68rem; color:#4a6a88; }
        .fc-ia-windows { display:flex; gap:7px; flex-wrap:wrap; }
        .fc-iawin { padding:3px 9px; border-radius:20px; font-size:.66rem; font-weight:600; letter-spacing:.04em; display:flex; align-items:center; gap:4px; }
        .fc-iawin-on { background:rgba(236,72,153,.15); border:1px solid rgba(236,72,153,.3); color:#ec4899; }
        .fc-iawin-off { background:rgba(255,255,255,.04); border:1px solid rgba(255,255,255,.07); color:#4a6a88; }
        .fc-iawin-dot { width:5px; height:5px; border-radius:50%; background:currentColor; }
        .fc-iawin-on .fc-iawin-dot { animation:fc-blink 1.4s ease-in-out infinite; }
      `}</style>

      {/* Header */}
      <div className="fc-header">
        <div>
          <small className="fc-header-small">RAFI Dashboard</small>
          <h2 className="fc-header-h1">Horário de Mercado Forex</h2>
        </div>
        <div>
          <div className="fc-utc-label">UTC agora</div>
          <div className="fc-utc-time">{utcStr}</div>
        </div>
      </div>

      {/* Banner de sobreposições */}
      <div className="fc-banner">
        <span className="fc-banner-label">Sessões</span>
        <div className="fc-chips" id="fc-chips" />
      </div>

      {/* Grade de 4 relógios */}
      <div className="fc-grid">
        {SESS.map(s => (
          <div key={s.key} className="fc-card" id={`fc-card-${s.key}`}>
            <div className="fc-city">
              <span className="fc-flag">{s.flag}</span>
              {s.name}
            </div>
            <div id={`fc-svgw-${s.key}`} style={{ width: '100%', display: 'flex', justifyContent: 'center' }} />
            <div className="fc-digital" id={`fc-dig-${s.key}`}>--:--:--</div>
            <div className="fc-tz" id={`fc-tz-${s.key}`}>&nbsp;</div>
            <div className="fc-badge fc-badge-closed" id={`fc-badge-${s.key}`}>
              <span className="fc-bdot" />FECHADA
            </div>
            <div className="fc-eta" id={`fc-eta-${s.key}`}>&nbsp;</div>
          </div>
        ))}
      </div>

      {/* Timeline 24h */}
      <div className="fc-section">
        <div className="fc-tl-header">
          <div className="fc-tl-title">Linha do tempo — 24h UTC</div>
          <div className="fc-tl-badge" id="fc-tl-badge">00:00 UTC</div>
        </div>
        <div className="fc-tl-wrap">
          <div className="fc-tl-bar" id="fc-tl-bar">
            {TL_SEGS.map((seg, i) => (
              <div key={i} className="fc-tl-seg" style={{ left: `${(seg.s / 24 * 100).toFixed(2)}%`, width: `${((seg.e - seg.s) / 24 * 100).toFixed(2)}%`, background: seg.c, opacity: seg.o }} />
            ))}
            {TL_IA.map((w, i) => (
              <div key={i} className="fc-tl-ia" style={{ left: `${(w.s / 24 * 100).toFixed(2)}%`, width: `${((w.e - w.s) / 24 * 100).toFixed(2)}%` }} />
            ))}
          </div>
          <div className="fc-tl-needle" id="fc-tl-needle" style={{ left: '0%' }} />
        </div>
        <div className="fc-tl-labels">
          {['00:00','04:00','08:00','12:00','16:00','20:00','24:00'].map(l => (
            <span key={l} className="fc-tl-lbl">{l}</span>
          ))}
        </div>
        <div className="fc-tl-legend">
          {[['#10b981','Sydney'],['#38bdf8','Tóquio'],['#f59e0b','Londres'],['#8b5cf6','Nova York'],['#ec4899','IA RAFI']].map(([c, n]) => (
            <div key={n} className="fc-tl-leg-item">
              <div className="fc-tl-leg-sw" style={{ background: c }} />
              {n}
            </div>
          ))}
        </div>
      </div>

      {/* Painel IA */}
      <div className="fc-ia-panel">
        <div className="fc-ia-left">
          <div className="fc-ia-icon">🤖</div>
          <div>
            <div className="fc-ia-title">IA RAFI — Janelas de operação</div>
            <div className="fc-ia-sub" id="fc-ia-sub">Calculando próximo scan…</div>
          </div>
        </div>
        <div className="fc-ia-windows" id="fc-ia-windows" />
      </div>
    </div>
  )
}
