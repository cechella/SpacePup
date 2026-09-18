-- ── Migração: Fusion Markets + suporte multi-broker MetaAPI ─────────────────
-- Execute no Supabase SQL Editor

-- 1. Adiciona coluna metaapi_account_id em rafi_brokers (guarda o UUID do MetaAPI por corretora)
ALTER TABLE rafi_brokers
  ADD COLUMN IF NOT EXISTS metaapi_account_id TEXT,
  ADD COLUMN IF NOT EXISTS nome               TEXT,
  ADD COLUMN IF NOT EXISTS tipo               TEXT DEFAULT 'ECN',
  ADD COLUMN IF NOT EXISTS broker_priority    INTEGER DEFAULT 99,
  ADD COLUMN IF NOT EXISTS health_score       NUMERIC(4,1) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS health_estado      TEXT DEFAULT 'STANDBY',
  ADD COLUMN IF NOT EXISTS saldo              NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS posicoes           INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pnl_hoje          NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status_text        TEXT DEFAULT 'STANDBY';

-- 2. Cadastra Fusion Markets
INSERT INTO rafi_brokers (
  id, nome, tipo, login, servidor, simbolo,
  mt5_login, mt5_servidor, mt5_simbolo,
  mt5_path,
  enabled, broker_priority,
  health_estado, saldo
) VALUES (
  'fusion_markets',
  'Fusion Markets',
  'ECN Zero',
  4011824,
  'FusionMarkets-Live',
  'EURUSD',
  4011824,
  'FusionMarkets-Live',
  'EURUSD',
  'C:\Program Files\MetaTrader 5 FusionMarkets\terminal64.exe',
  false,   -- começa desligado até a conta sair do Pending
  30,      -- prioridade: atrás da Pepperstone (10)
  'STANDBY',
  20.00
)
ON CONFLICT (id) DO UPDATE SET
  nome         = EXCLUDED.nome,
  tipo         = EXCLUDED.tipo,
  login        = EXCLUDED.login,
  servidor     = EXCLUDED.servidor,
  mt5_login    = EXCLUDED.mt5_login,
  mt5_servidor = EXCLUDED.mt5_servidor,
  mt5_path     = EXCLUDED.mt5_path,
  updated_at   = NOW();

-- 3. Cria entrada de saúde para Fusion Markets (broker_health_state)
INSERT INTO broker_health_state (broker_id, estado, circuit_breaker, health_score)
VALUES ('fusion_markets', 'STANDBY', 'CLOSED', 0)
ON CONFLICT (broker_id) DO NOTHING;

-- ── Verificação ──────────────────────────────────────────────────────────────
SELECT id, nome, enabled, mt5_login, mt5_servidor, metaapi_account_id, broker_priority
FROM rafi_brokers
ORDER BY broker_priority;
