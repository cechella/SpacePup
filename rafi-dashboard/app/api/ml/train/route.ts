/**
 * POST /api/ml/train
 * Treina o modelo XGBoost em TypeScript com todos os trades rotulados do Supabase.
 * Requer ≥ 50 trades. Salva o modelo JSON em rafi_ml_models (upsert name='xgboost_ts').
 */
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { trainXGBoost } from '@/lib/ml/xgboost'
import { extractFeatures, featuresToArray } from '@/lib/ml/features'

function getServiceClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_SERVICE_ROLE_KEY não configurada')
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function POST() {
  const t0 = Date.now()
  try {
    const supa = getServiceClient()

    // Busca todos os trades rotulados com features disponíveis
    const { data: rows, error } = await supa
      .from('rafi_trades')
      .select('rafi, direction, time, bb_width, result, checkin_sono, checkin_energia, checkin_mental, checkin_humor')
      .in('result', ['win', 'loss'])
      .order('time', { ascending: true })

    if (error) throw error

    const trades = rows ?? []
    if (trades.length < 50) {
      return NextResponse.json({
        ok: false,
        reason: `Trades insuficientes: ${trades.length} (mínimo 50 para treinar)`,
        labeled_count: trades.length,
      })
    }

    // Monta dataset: X = features, y = label
    const X: number[][] = []
    const y: number[]   = []
    for (const t of trades) {
      X.push(featuresToArray(extractFeatures(t as any)))
      y.push(t.result === 'win' ? 1 : 0)
    }

    // Treina o modelo — ~100–500ms para 50–300 amostras
    const model = trainXGBoost(X, y, 30, 3, 0.1)

    // Salva no Supabase (upsert por nome)
    const { error: saveErr } = await supa
      .from('rafi_ml_models')
      .upsert(
        {
          name:           'xgboost_ts',
          model_json:     model,
          trained_at:     model.trainedAt,
          n_samples:      model.nSamples,
          train_accuracy: model.trainAccuracy,
          updated_at:     new Date().toISOString(),
        },
        { onConflict: 'name' },
      )

    if (saveErr) throw saveErr

    const elapsed = Date.now() - t0
    return NextResponse.json({
      ok:            true,
      n_samples:     model.nSamples,
      train_accuracy: Math.round(model.trainAccuracy * 100),
      elapsed_ms:    elapsed,
      trained_at:    model.trainedAt,
    })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
