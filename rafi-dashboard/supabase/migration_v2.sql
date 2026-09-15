-- ============================================================
-- Migration V2 — RAFI Trading Dashboard
-- Execute no SQL Editor do Supabase (Dashboard → SQL Editor)
-- Idempotente: pode rodar em instâncias novas E existentes.
-- CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS +
-- políticas criadas via DO $$ para não quebrar se já existirem.
-- ============================================================

-- ── Colunas extras no rafi_trades (contexto de sessão para IA) ────────────────
ALTER TABLE rafi_trades
  ADD COLUMN IF NOT EXISTS pnl_usd         NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS capital_inicial  NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS overlap_phase    TEXT,
  ADD COLUMN IF NOT EXISTS session_minute   INTEGER,
  ADD COLUMN IF NOT EXISTS day_of_week      SMALLINT,
  ADD COLUMN IF NOT EXISTS entry_type       TEXT DEFAULT 'manual';

-- ── rafi_candles: cache de candles OHLCV (BIGINT Unix seconds) ────────────────
CREATE TABLE IF NOT EXISTS rafi_candles (
  time       BIGINT        NOT NULL UNIQUE,
  open       NUMERIC(10,5) NOT NULL,
  high       NUMERIC(10,5) NOT NULL,
  low        NUMERIC(10,5) NOT NULL,
  close      NUMERIC(10,5) NOT NULL,
  volume     INTEGER       NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ   DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rafi_candles_time ON rafi_candles(time DESC);
ALTER TABLE rafi_candles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_candles' AND policyname='rafi_candles_public_all') THEN
    CREATE POLICY "rafi_candles_public_all" ON rafi_candles FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ── rafi_bot_status: estado em tempo real do executor.py ──────────────────────
CREATE TABLE IF NOT EXISTS rafi_bot_status (
  id                  TEXT PRIMARY KEY,
  status              TEXT DEFAULT 'stopped',
  balance             NUMERIC(12,2),
  equity              NUMERIC(12,2),
  open_positions      INTEGER DEFAULT 0,
  pnl_today           NUMERIC(10,2) DEFAULT 0,
  par                 TEXT DEFAULT 'EURUSD',
  server              TEXT,
  account             BIGINT,
  last_signal         TEXT,
  forming_signal      BOOLEAN,
  forming_direction   TEXT,
  forming_rafi        NUMERIC(6,3),
  forming_tf_count    INTEGER,
  forming_bb_open     BOOLEAN,
  forming_price       NUMERIC(10,5),
  config_hash         TEXT,
  ml_modelo_carregado BOOLEAN DEFAULT FALSE,
  ml_modo             TEXT,
  ml_wr_rolling       NUMERIC(6,4),
  ml_pf_rolling       NUMERIC(6,4),
  ml_sinais_hoje      INTEGER DEFAULT 0,
  ml_aprovados_hoje   INTEGER DEFAULT 0,
  ml_treinado_em      TIMESTAMPTZ,
  ml_threshold        NUMERIC(4,2) DEFAULT 0.65,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE rafi_bot_status ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_bot_status' AND policyname='rafi_bot_status_read') THEN
    CREATE POLICY "rafi_bot_status_read" ON rafi_bot_status FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_bot_status' AND policyname='rafi_bot_status_service_write') THEN
    CREATE POLICY "rafi_bot_status_service_write" ON rafi_bot_status
      FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- ── rafi_bot_logs: log de execução ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rafi_bot_logs (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  level      TEXT        NOT NULL DEFAULT 'info',
  message    TEXT        NOT NULL,
  details    TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rafi_bot_logs_created ON rafi_bot_logs(created_at DESC);
ALTER TABLE rafi_bot_logs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_bot_logs' AND policyname='rafi_bot_logs_read') THEN
    CREATE POLICY "rafi_bot_logs_read" ON rafi_bot_logs FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_bot_logs' AND policyname='rafi_bot_logs_service_write') THEN
    CREATE POLICY "rafi_bot_logs_service_write" ON rafi_bot_logs
      FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- ── rafi_bot_commands: fila dashboard → bot ───────────────────────────────────
CREATE TABLE IF NOT EXISTS rafi_bot_commands (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  command    TEXT        NOT NULL,
  pending    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rafi_bot_commands_pending ON rafi_bot_commands(pending, created_at DESC);
ALTER TABLE rafi_bot_commands ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_bot_commands' AND policyname='rafi_bot_commands_public_insert') THEN
    CREATE POLICY "rafi_bot_commands_public_insert" ON rafi_bot_commands FOR INSERT WITH CHECK (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_bot_commands' AND policyname='rafi_bot_commands_read') THEN
    CREATE POLICY "rafi_bot_commands_read" ON rafi_bot_commands FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_bot_commands' AND policyname='rafi_bot_commands_service_all') THEN
    CREATE POLICY "rafi_bot_commands_service_all" ON rafi_bot_commands
      FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

-- ── rafi_bot_config: parâmetros da estratégia (live / simulator) ──────────────
CREATE TABLE IF NOT EXISTS rafi_bot_config (
  profile                  TEXT PRIMARY KEY,
  estrategia_modo          TEXT         DEFAULT 'normal',
  forca_limiar             NUMERIC(5,2) DEFAULT 2.5,
  rafi_periodo             INTEGER      DEFAULT 14,
  sr_lookback              INTEGER      DEFAULT 20,
  swing_stop_lookback      INTEGER      DEFAULT 5,
  ma_rapida                INTEGER      DEFAULT 9,
  ma_lenta                 INTEGER      DEFAULT 21,
  ma_threshold             NUMERIC(6,4) DEFAULT 0.0002,
  bb_filtro_ativo          BOOLEAN      DEFAULT TRUE,
  bb_limiar_estreita       NUMERIC(6,4) DEFAULT 0.0020,
  bb_periodo               INTEGER      DEFAULT 8,
  bb_desvios               NUMERIC(4,2) DEFAULT 2.0,
  ratio_risco_retorno      NUMERIC(4,2) DEFAULT 1.5,
  max_trades_simultaneos   INTEGER      DEFAULT 2,
  autoscan_min_breakout    NUMERIC(6,4) DEFAULT 0.0005,
  autoscan_min_gap_candles INTEGER      DEFAULT 3,
  autoscan_stop_offset     NUMERIC(6,4) DEFAULT 0.0003,
  bb_squeeze_expansao_min  NUMERIC(6,4) DEFAULT 0.0005,
  updated_at               TIMESTAMPTZ  DEFAULT NOW()
);

ALTER TABLE rafi_bot_config ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_bot_config' AND policyname='rafi_bot_config_read') THEN
    CREATE POLICY "rafi_bot_config_read" ON rafi_bot_config FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_bot_config' AND policyname='rafi_bot_config_service_write') THEN
    CREATE POLICY "rafi_bot_config_service_write" ON rafi_bot_config
      FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

INSERT INTO rafi_bot_config (profile) VALUES ('live')      ON CONFLICT (profile) DO NOTHING;
INSERT INTO rafi_bot_config (profile) VALUES ('simulator') ON CONFLICT (profile) DO NOTHING;

-- ── rafi_config_risco: parâmetros de risco ────────────────────────────────────
CREATE TABLE IF NOT EXISTS rafi_config_risco (
  id        SERIAL PRIMARY KEY,
  chave     TEXT UNIQUE NOT NULL,
  valor     TEXT NOT NULL,
  descricao TEXT,
  bloqueado BOOLEAN DEFAULT FALSE
);

ALTER TABLE rafi_config_risco ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_config_risco' AND policyname='rafi_config_risco_read') THEN
    CREATE POLICY "rafi_config_risco_read" ON rafi_config_risco FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_config_risco' AND policyname='rafi_config_risco_service_write') THEN
    CREATE POLICY "rafi_config_risco_service_write" ON rafi_config_risco
      FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

INSERT INTO rafi_config_risco (chave, valor, descricao, bloqueado) VALUES
  ('capital_inicial',     '100',  'Capital inicial em USD',                         false),
  ('risco_por_trade_pct', '1.0',  '% do capital em risco por trade',                false),
  ('max_trades_dia',      '5',    'Máximo de trades por dia',                        false),
  ('perda_max_dia_pct',   '5.0',  '% de perda diária que para o bot',                true),
  ('max_trades_simult',   '2',    'Máximo de posições abertas simultaneamente',       true)
ON CONFLICT (chave) DO NOTHING;

-- ── rafi_lote_faixas: escalonamento de lote por capital ───────────────────────
CREATE TABLE IF NOT EXISTS rafi_lote_faixas (
  ordem       INTEGER PRIMARY KEY,
  lote        NUMERIC(8,4) NOT NULL,
  capital_min NUMERIC(10,2) NOT NULL,
  capital_max NUMERIC(10,2),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE rafi_lote_faixas ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_lote_faixas' AND policyname='rafi_lote_faixas_read') THEN
    CREATE POLICY "rafi_lote_faixas_read" ON rafi_lote_faixas FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_lote_faixas' AND policyname='rafi_lote_faixas_service_write') THEN
    CREATE POLICY "rafi_lote_faixas_service_write" ON rafi_lote_faixas
      FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;

INSERT INTO rafi_lote_faixas (ordem, lote, capital_min, capital_max) VALUES
  (1, 0.01, 0,    99.99),
  (2, 0.02, 100,  199.99),
  (3, 0.03, 200,  299.99),
  (4, 0.05, 300,  499.99),
  (5, 0.08, 500,  999.99),
  (6, 0.10, 1000, NULL)
ON CONFLICT (ordem) DO NOTHING;

-- ── rafi_brokers: corretoras cadastradas ──────────────────────────────────────
-- A tabela já existe — só adiciona colunas que o código espera e que podem faltar.
-- NÃO tenta criar nem inserir linhas: a tabela já tem dados e um schema próprio
-- (ex: coluna 'nome' NOT NULL em vez de 'name').
CREATE TABLE IF NOT EXISTS rafi_brokers (
  id         TEXT PRIMARY KEY,
  enabled    BOOLEAN     DEFAULT TRUE,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Adiciona colunas usadas pelo dashboard (ignora se já existirem)
ALTER TABLE rafi_brokers
  ADD COLUMN IF NOT EXISTS name         TEXT,
  ADD COLUMN IF NOT EXISTS login        BIGINT,
  ADD COLUMN IF NOT EXISTS servidor     TEXT,
  ADD COLUMN IF NOT EXISTS simbolo      TEXT DEFAULT 'EURUSD',
  ADD COLUMN IF NOT EXISTS mt5_login    BIGINT,
  ADD COLUMN IF NOT EXISTS mt5_senha    TEXT,
  ADD COLUMN IF NOT EXISTS mt5_servidor TEXT,
  ADD COLUMN IF NOT EXISTS mt5_simbolo  TEXT,
  ADD COLUMN IF NOT EXISTS mt5_path     TEXT;

ALTER TABLE rafi_brokers ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_brokers' AND policyname='rafi_brokers_read') THEN
    CREATE POLICY "rafi_brokers_read" ON rafi_brokers FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_brokers' AND policyname='rafi_brokers_service_write') THEN
    CREATE POLICY "rafi_brokers_service_write" ON rafi_brokers
      FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');
  END IF;
END $$;
-- INSERT omitido: a tabela já tem a corretora cadastrada com schema próprio.

-- ── rafi_historico: espelho de deals fechados do MetaAPI ──────────────────────
CREATE TABLE IF NOT EXISTS rafi_historico (
  id         TEXT PRIMARY KEY,
  symbol     TEXT,
  type       TEXT,
  volume     NUMERIC(8,2),
  price      NUMERIC(10,5),
  profit     NUMERIC(10,2),
  time       TIMESTAMPTZ,
  comment    TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rafi_historico_time ON rafi_historico(time DESC);
ALTER TABLE rafi_historico ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_historico' AND policyname='rafi_historico_public_all') THEN
    CREATE POLICY "rafi_historico_public_all" ON rafi_historico FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;

-- ── rafi_backtest_runs: runs de backtest ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS rafi_backtest_runs (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  periodo      TEXT,
  inicio       DATE,
  fim          DATE,
  capital      NUMERIC(10,2) DEFAULT 100.0,
  profile      TEXT DEFAULT 'simulator',
  broker       TEXT DEFAULT 'auto',
  rr_override  NUMERIC(4,2),
  status       TEXT DEFAULT 'pending',
  progress_pct INTEGER DEFAULT 0,
  config_hash  TEXT,
  resultado    JSONB,
  error_msg    TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rafi_backtest_runs_status ON rafi_backtest_runs(status, created_at DESC);
ALTER TABLE rafi_backtest_runs ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_backtest_runs' AND policyname='rafi_backtest_runs_read') THEN
    CREATE POLICY "rafi_backtest_runs_read" ON rafi_backtest_runs FOR SELECT USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rafi_backtest_runs' AND policyname='rafi_backtest_runs_anon_write') THEN
    CREATE POLICY "rafi_backtest_runs_anon_write" ON rafi_backtest_runs FOR ALL USING (true) WITH CHECK (true);
  END IF;
END $$;
