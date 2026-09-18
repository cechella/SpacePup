-- ── Migração: IC Markets Raw Spread ─────────────────────────────────────────
-- Execute no Supabase SQL Editor (https://supabase.com → SQL Editor)

-- 1. Cadastra IC Markets
INSERT INTO rafi_brokers (
  id, nome, tipo, login, servidor, simbolo,
  mt5_login, mt5_servidor, mt5_simbolo,
  metaapi_account_id,
  enabled, broker_priority,
  health_estado
) VALUES (
  'icmarkets',
  'IC Markets',
  'Raw Spread',
  8113869,
  'ICMarketsSC-MT5-3',
  'EURUSD',
  8113869,
  'ICMarketsSC-MT5-3',
  'EURUSD',
  '5668ddbf-de77-4d4f-b4ef-6d86631bb14f',
  false,  -- começa desligada
  4,      -- prioridade 4 (após Exness=1, Pepperstone=2, Tickmill=3)
  'STANDBY'
)
ON CONFLICT (id) DO UPDATE SET
  nome               = EXCLUDED.nome,
  metaapi_account_id = EXCLUDED.metaapi_account_id,
  mt5_login          = EXCLUDED.mt5_login,
  mt5_servidor       = EXCLUDED.mt5_servidor,
  broker_priority    = EXCLUDED.broker_priority,
  updated_at         = NOW();

-- 2. Cria entrada de saúde para IC Markets
INSERT INTO broker_health_state (broker_id, estado, circuit_breaker, health_score)
VALUES ('icmarkets', 'STANDBY', 'CLOSED', 0)
ON CONFLICT (broker_id) DO NOTHING;

-- ── Verificação ──────────────────────────────────────────────────────────────
SELECT id, nome, enabled, mt5_login, mt5_servidor, metaapi_account_id, broker_priority
FROM rafi_brokers
ORDER BY broker_priority;
