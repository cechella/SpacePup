'use strict'

require('dotenv').config()

const MetaApi            = require('metaapi.cloud-sdk').default
const SynchronizationListener = require('metaapi.cloud-sdk').SynchronizationListener
const { createClient }   = require('@supabase/supabase-js')

// ── Variáveis de ambiente ─────────────────────────────────────────────────────
const MA_TOKEN = process.env.METAAPI_TOKEN
const SUPA_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const MA_BASE  = process.env.METAAPI_BASE_URL ?? 'https://mt-client-api-v1.london.agiliumtrade.ai'

if (!MA_TOKEN || !SUPA_URL || !SUPA_KEY) {
  console.error('[bridge] ERRO: variáveis ausentes — METAAPI_TOKEN, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supa = createClient(SUPA_URL, SUPA_KEY, { auth: { persistSession: false } })
const api  = new MetaApi(MA_TOKEN)

// ── Helpers Supabase ──────────────────────────────────────────────────────────

async function upsertPosition(brokerId, pos) {
  const { error } = await supa.from('rafi_positions').upsert({
    id:            pos.id,
    broker_id:     brokerId,
    symbol:        pos.symbol,
    type:          pos.type,
    direction:     pos.type === 'POSITION_TYPE_BUY' ? 'buy' : 'sell',
    volume:        pos.volume,
    open_price:    pos.openPrice,
    current_price: pos.currentPrice ?? pos.openPrice,
    profit:        pos.profit        ?? 0,
    swap:          pos.swap          ?? 0,
    commission:    pos.commission    ?? 0,
    opened_at:     pos.time,
    comment:       pos.comment       ?? '',
    raw:           pos,
    updated_at:    new Date().toISOString(),
  }, { onConflict: 'id' })
  if (error) console.error(`[bridge] upsertPosition erro:`, error.message)
}

async function removePosition(positionId) {
  const { error } = await supa.from('rafi_positions').delete().eq('id', positionId)
  if (error) console.error(`[bridge] removePosition erro:`, error.message)
}

async function saveDeal(brokerId, deal) {
  // Salva todos os deals relevantes (ENTRY_IN = abertura, ENTRY_OUT = fechamento)
  if (deal.entryType !== 'DEAL_ENTRY_IN' && deal.entryType !== 'DEAL_ENTRY_OUT' && deal.entryType !== 'DEAL_ENTRY_INOUT') return

  const direction = deal.entryType === 'DEAL_ENTRY_OUT'
    ? (deal.type === 'DEAL_TYPE_SELL' ? 'buy' : 'sell')
    : null

  const { error } = await supa.from('rafi_deals').upsert({
    id:          deal.id,
    broker_id:   brokerId,
    position_id: deal.positionId ?? null,
    symbol:      deal.symbol,
    entry_type:  deal.entryType,
    deal_type:   deal.type,
    direction,
    volume:      deal.volume     ?? 0,
    price:       deal.price      ?? 0,
    profit:      deal.profit     ?? 0,
    commission:  deal.commission ?? 0,
    swap:        deal.swap       ?? 0,
    comment:     deal.comment    ?? '',
    time:        deal.time,
    raw:         deal,
    created_at:  new Date().toISOString(),
  }, { onConflict: 'id' })
  if (error) console.error(`[bridge] saveDeal erro:`, error.message)
}

// ── Sincronização histórica (startup): evita lacunas se bridge ficou offline ──

async function syncHistory(brokerId, accountId) {
  try {
    const to   = new Date().toISOString()
    const from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

    const res = await fetch(
      `${MA_BASE}/users/current/accounts/${accountId}/history-deals/time/${from}/${to}`,
      { headers: { 'auth-token': MA_TOKEN }, signal: AbortSignal.timeout(20_000) },
    )

    if (!res.ok) {
      console.warn(`[bridge] ${brokerId} — histórico não disponível (HTTP ${res.status})`)
      return
    }

    const deals = await res.json()
    if (!Array.isArray(deals) || !deals.length) {
      console.log(`[bridge] ${brokerId} — sem deals nos últimos 30 dias`)
      return
    }

    const toSave = deals.filter(d =>
      d.entryType === 'DEAL_ENTRY_IN' ||
      d.entryType === 'DEAL_ENTRY_OUT' ||
      d.entryType === 'DEAL_ENTRY_INOUT',
    )

    console.log(`[bridge] ${brokerId} — sincronizando ${toSave.length} deals históricos`)

    // Upsert em lotes de 100 para não sobrecarregar o Supabase
    for (let i = 0; i < toSave.length; i += 100) {
      const batch = toSave.slice(i, i + 100).map(deal => {
        const direction = deal.entryType === 'DEAL_ENTRY_OUT'
          ? (deal.type === 'DEAL_TYPE_SELL' ? 'buy' : 'sell')
          : null
        return {
          id:          deal.id,
          broker_id:   brokerId,
          position_id: deal.positionId ?? null,
          symbol:      deal.symbol,
          entry_type:  deal.entryType,
          deal_type:   deal.type,
          direction,
          volume:      deal.volume     ?? 0,
          price:       deal.price      ?? 0,
          profit:      deal.profit     ?? 0,
          commission:  deal.commission ?? 0,
          swap:        deal.swap       ?? 0,
          comment:     deal.comment    ?? '',
          time:        deal.time,
          raw:         deal,
          created_at:  new Date().toISOString(),
        }
      })
      await supa.from('rafi_deals').upsert(batch, { onConflict: 'id' })
    }

    console.log(`[bridge] ${brokerId} — histórico sincronizado ✓`)
  } catch (err) {
    console.error(`[bridge] ${brokerId} — erro na sincronização histórica:`, err.message)
  }
}

// ── Listener de sincronização por corretora ───────────────────────────────────

class RafiListener extends SynchronizationListener {
  constructor(brokerId) {
    super()
    this.brokerId = brokerId
  }

  // Posições sincronizadas pela primeira vez
  async onPositionsReplaced(instanceIndex, positions) {
    console.log(`[bridge] ${this.brokerId} — ${positions.length} posições abertas`)
    // Limpa posições antigas desta corretora e reinsere
    await supa.from('rafi_positions').delete().eq('broker_id', this.brokerId)
    for (const pos of positions) {
      await upsertPosition(this.brokerId, pos)
    }
  }

  // Posição atualizada (profit flutuante mudou)
  async onPositionUpdated(instanceIndex, position) {
    await upsertPosition(this.brokerId, position)
  }

  // Posição removida (trade fechado)
  async onPositionRemoved(instanceIndex, positionId) {
    console.log(`[bridge] ${this.brokerId} — posição ${positionId} encerrada`)
    await removePosition(positionId)
  }

  // Novo deal adicionado ao histórico
  async onDealAdded(instanceIndex, deal) {
    console.log(`[bridge] ${this.brokerId} — deal ${deal.id} (${deal.entryType}) ${deal.symbol} profit=${deal.profit ?? 0}`)
    await saveDeal(this.brokerId, deal)
  }
}

// ── Conecta uma conta via streaming ──────────────────────────────────────────

async function connectAccount(brokerId, accountId) {
  console.log(`[bridge] Conectando ${brokerId} (${accountId})...`)

  const account = await api.metatraderAccountApi.getAccount(accountId)

  // Faz deploy se necessário
  if (!['DEPLOYED', 'DEPLOYING'].includes(account.state)) {
    await account.deploy()
  }
  await account.waitConnected()

  // Sincronização histórica antes de ligar streaming
  await syncHistory(brokerId, accountId)

  // Configura streaming
  const conn     = account.getStreamingConnection()
  const listener = new RafiListener(brokerId)
  conn.addSynchronizationListener(listener)

  await conn.connect()
  await conn.waitSynchronized({ timeoutInSeconds: 60 })

  console.log(`[bridge] ${brokerId} — streaming ativo ✓`)
  return conn
}

// ── Ponto de entrada ──────────────────────────────────────────────────────────

async function main() {
  console.log('[bridge] Iniciando RAFI MetaAPI Bridge...')

  // Busca corretoras habilitadas no Supabase
  const { data: brokers, error } = await supa
    .from('rafi_brokers')
    .select('id, nome, metaapi_account_id')
    .eq('enabled', true)
    .not('metaapi_account_id', 'is', null)

  if (error) {
    console.error('[bridge] Erro ao buscar corretoras:', error.message)
    process.exit(1)
  }

  console.log(`[bridge] ${brokers.length} corretoras: ${brokers.map(b => b.id).join(', ')}`)

  // Conecta todas em paralelo
  const results = await Promise.allSettled(
    brokers.map(b => connectAccount(b.id, b.metaapi_account_id)),
  )

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[bridge] Falha ao conectar ${brokers[i].id}:`, r.reason?.message ?? r.reason)
    }
  })

  const connected = results.filter(r => r.status === 'fulfilled').length
  console.log(`[bridge] ${connected}/${brokers.length} contas conectadas. Aguardando eventos...`)

  // Mantém o processo vivo; NSSM reinicia em caso de crash
  process.on('SIGINT',  () => { console.log('[bridge] Encerrando...'); process.exit(0) })
  process.on('SIGTERM', () => { console.log('[bridge] Encerrando...'); process.exit(0) })

  // Heartbeat a cada 5 min para confirmar que está vivo
  setInterval(() => {
    console.log(`[bridge] ♡ heartbeat — ${new Date().toISOString()}`)
  }, 5 * 60 * 1000)
}

main().catch(err => {
  console.error('[bridge] Erro fatal:', err)
  process.exit(1)
})
