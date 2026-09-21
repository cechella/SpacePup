-- ============================================================
-- Migration: Real-Time Bridge — posições ao vivo + histórico completo
-- Execute no SQL Editor do Supabase
-- Idempotente: CREATE TABLE IF NOT EXISTS + DROP POLICY IF EXISTS
-- ============================================================

-- ── rafi_positions: posições abertas em tempo real (alimentadas pelo bridge) ──
CREATE TABLE IF NOT EXISTS rafi_positions (
  id            TEXT          PRIMARY KEY,          -- MetaAPI position ID
  broker_id     TEXT          NOT NULL,             -- FK rafi_brokers.id
  symbol        TEXT          NOT NULL,
  type          TEXT          NOT NULL,             -- POSITION_TYPE_BUY | POSITION_TYPE_SELL
  direction     TEXT          NOT NULL,             -- buy | sell
  volume        NUMERIC(8,2)  NOT NULL,
  open_price    NUMERIC(10,5) NOT NULL,
  current_price NUMERIC(10,5),
  profit        NUMERIC(10,2) DEFAULT 0,
  swap          NUMERIC(10,2) DEFAULT 0,
  commission    NUMERIC(10,2) DEFAULT 0,
  opened_at     TIMESTAMPTZ   NOT NULL,
  comment       TEXT,
  raw           JSONB,                              -- objeto completo do MetaAPI (stop/tp, etc.)
  updated_at    TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rafi_positions_broker ON rafi_positions(broker_id);

ALTER TABLE rafi_positions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rafi_positions_read"          ON rafi_positions;
DROP POLICY IF EXISTS "rafi_positions_service_write" ON rafi_positions;

CREATE POLICY "rafi_positions_read" ON rafi_positions
  FOR SELECT USING (true);

CREATE POLICY "rafi_positions_service_write" ON rafi_positions
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ── rafi_deals: histórico completo de deals (ENTRY_IN + ENTRY_OUT) ────────────
-- Substitui rafi_historico com esquema mais rico
CREATE TABLE IF NOT EXISTS rafi_deals (
  id          TEXT          PRIMARY KEY,            -- MetaAPI deal ID
  broker_id   TEXT          NOT NULL,               -- FK rafi_brokers.id
  position_id TEXT,                                 -- agrupa ENTRY_IN + ENTRY_OUT
  symbol      TEXT          NOT NULL,
  entry_type  TEXT          NOT NULL,               -- DEAL_ENTRY_IN | DEAL_ENTRY_OUT | DEAL_ENTRY_INOUT
  deal_type   TEXT          NOT NULL,               -- DEAL_TYPE_BUY | DEAL_TYPE_SELL
  direction   TEXT,                                 -- buy | sell (só para ENTRY_OUT)
  volume      NUMERIC(8,2),
  price       NUMERIC(10,5),
  profit      NUMERIC(10,2) DEFAULT 0,
  commission  NUMERIC(10,2) DEFAULT 0,
  swap        NUMERIC(10,2) DEFAULT 0,
  comment     TEXT,
  time        TIMESTAMPTZ   NOT NULL,
  raw         JSONB,
  created_at  TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rafi_deals_time       ON rafi_deals(time DESC);
CREATE INDEX IF NOT EXISTS idx_rafi_deals_broker     ON rafi_deals(broker_id, time DESC);
CREATE INDEX IF NOT EXISTS idx_rafi_deals_position   ON rafi_deals(position_id);
CREATE INDEX IF NOT EXISTS idx_rafi_deals_entry_type ON rafi_deals(entry_type, time DESC);

ALTER TABLE rafi_deals ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rafi_deals_read"          ON rafi_deals;
DROP POLICY IF EXISTS "rafi_deals_service_write" ON rafi_deals;

CREATE POLICY "rafi_deals_read" ON rafi_deals
  FOR SELECT USING (true);

CREATE POLICY "rafi_deals_service_write" ON rafi_deals
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ── Habilitar Realtime nas duas tabelas ───────────────────────────────────────
-- Execute no Supabase Dashboard → Table Editor → cada tabela → Realtime = ON
-- OU via API:
ALTER PUBLICATION supabase_realtime ADD TABLE rafi_positions;
ALTER PUBLICATION supabase_realtime ADD TABLE rafi_deals;
