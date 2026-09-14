import { NextRequest } from 'next/server'

export const runtime = 'edge'

const BASE    = 'https://mt-client-api-v1.london.agiliumtrade.ai'
const TOKEN   = process.env.METAAPI_TOKEN!
const ACCOUNT = process.env.METAAPI_ACCOUNT_ID!

// SSE: envia ticks em tempo real a cada ~300ms (sem recriar conexão a cada update)
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const symbol = searchParams.get('symbol') || 'EURUSD'

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      const send = (data: object) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`))
        } catch {}
      }

      // Heartbeat inicial para confirmar conexão
      send({ type: 'connected', symbol })

      let lastBid = 0
      let lastAsk = 0

      while (true) {
        // Para o loop se o cliente desconectou
        if (req.signal.aborted) break

        try {
          const res = await fetch(
            `${BASE}/users/current/accounts/${ACCOUNT}/symbols/${symbol}/current-price?keepSubscription=true`,
            {
              headers: { 'auth-token': TOKEN },
              signal: AbortSignal.timeout(4000),
            }
          )
          if (res.ok) {
            const data = await res.json()
            if (data.bid && data.ask) {
              // Só envia se o preço mudou (evita ticks duplicados)
              if (data.bid !== lastBid || data.ask !== lastAsk) {
                lastBid = data.bid
                lastAsk = data.ask
                send({ bid: data.bid, ask: data.ask, time: data.time, symbol })
              }
            }
          }
        } catch {
          // Ignora erros de rede temporários — continua tentando
        }

        // Aguarda 300ms antes do próximo tick
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 300)
          req.signal.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
        })
      }

      try { controller.close() } catch {}
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection':    'keep-alive',
      'X-Accel-Buffering': 'no', // desativa buffer do nginx/Vercel
    },
  })
}
