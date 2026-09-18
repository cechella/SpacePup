-- ============================================================
-- MIGRATION: broker_api_events
-- Execute no Supabase SQL Editor antes de fazer deploy.
-- Registra cada chamada MetaAPI por corretora para calcular
-- health score dinâmico (latência, sucesso, recência).
-- ============================================================

CREATE TABLE IF NOT EXISTS broker_api_events (
  id          bigserial    PRIMARY KEY,
  broker_id   text         NOT NULL REFERENCES rafi_brokers(id) ON DELETE CASCADE,
  event_type  text         NOT NULL CHECK (event_type IN ('order', 'close', 'modify', 'positions')),
  success     boolean      NOT NULL,
  latency_ms  integer      NOT NULL CHECK (latency_ms >= 0),
  error_msg   text,
  created_at  timestamptz  NOT NULL DEFAULT now()
);

-- Índice principal: leitura por broker_id + tempo decrescente
CREATE INDEX IF NOT EXISTS idx_broker_api_events_lookup
  ON broker_api_events (broker_id, created_at DESC);

-- Limpeza manual: apaga eventos com mais de 30 dias (rodar periodicamente)
-- DELETE FROM broker_api_events WHERE created_at < now() - interval '30 days';
