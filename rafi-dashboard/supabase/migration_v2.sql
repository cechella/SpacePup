-- ============================================================
-- Migration V2 — RAFI Trading Dashboard
-- Execute no SQL Editor do Supabase (Dashboard → SQL Editor)
-- Pode rodar quantas vezes quiser — todos os comandos são idempotentes
-- ============================================================

-- ── Colunas extras adicionadas ao rafi_trades (Fase IA) ───────────────────────
ALTER TABLE rafi_trades
  ADD COLUMN IF NOT EXISTS pnl_usd         NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS capital_inicial  NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS overlap_phase   TEXT CHECK (overlap_phase IN ('early','mid','late')),
  ADD COLUMN IF NOT EXISTS session_minute  INTEGER,
  ADD COLUMN IF NOT EXISTS day_of_week     SMALLINT CHECK (day_of_week BETWEEN 0 AND 3),
  ADD COLUMN IF NOT EXISTS entry_type      TEXT DEFAULT 'manual' CHECK (entry_type IN ('manual','bot'));

-- ── Candles OHLCV compactos (sem symbol/timeframe — fixo EURUSD M5) ───────────
-- Usado pelo dashboard para cache local: carrega instantâneo, incrementa via MetaAPI.
-- time = Unix timestamp em segundos (BIGINT), UNIQUE para upsert idempotente.
CREATE TABLE IF NOT EXISTS rafi_candles (
  time        BIGINT      NOT NULL UNIQUE,
  open        NUMERIC(10,5) NOT NULL,
  high        NUMERIC(10,5) NOT NULL,
  low         NUMERIC(10,5) NOT NULL,
  close       NUMERIC(10,5) NOT NULL,
  volume      INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rafi_candles_time ON rafi_candles(time DESC);

ALTER TABLE rafi_candles ENABLE ROW LEVEL SECURITY;

-- Leitura e escrita públicas (anon key) — dados de mercado, sem info sensível
CREATE POLICY "rafi_candles_public_all" ON rafi_candles
  FOR ALL USING (true) WITH CHECK (true);

-- ── Candles históricos do backtest (tabela nova que substitui a tabela 'candles') ─
-- (opcional, use só se migrar do schema antigo)
-- A tabela 'candles' do schema v1 usa TIMESTAMPTZ — rafi_candles usa BIGINT.
-- Não há conflito; podem coexistir.

-- ── Bot: status em tempo real (escrito pelo executor.py na VPS) ───────────────
CREATE TABLE IF NOT EXISTS rafi_bot_status (
  id               TEXT PRIMARY KEY,   -- ex: 'pepperstone' ou 'main' (legado)
  status           TEXT DEFAULT 'stopped' CHECK (status IN ('running','stopped','error','waiting')),
  balance          NUMERIC(12,2),
  equity           NUMERIC(12,2),
  open_positions   INTEGER DEFAULT 0,
  pnl_today        NUMERIC(10,2) DEFAULT 0,
  par              TEXT DEFAULT 'EURUSD',
  server           TEXT,
  account          BIGINT,
  last_signal      TEXT,
  -- Sinal em formação (exibido no monitor antes de ser confirmado)
  forming_signal   BOOLEAN,
  forming_direction TEXT CHECK (forming_direction IN ('buy','sell')),
  forming_rafi     NUMERIC(6,3),
  forming_tf_count INTEGER,
  forming_bb_open  BOOLEAN,
  forming_price    NUMERIC(10,5),
  config_hash      TEXT,
  -- Campos ML (Fase 2)
  ml_modelo_carregado  BOOLEAN DEFAULT FALSE,
  ml_modo              TEXT,
  ml_wr_rolling        NUMERIC(6,4),
  ml_pf_rolling        NUMERIC(6,4),
  ml_sinais_hoje       INTEGER DEFAULT 0,
  ml_aprovados_hoje    INTEGER DEFAULT 0,
  ml_treinado_em       TIMESTAMPTZ,
  ml_threshold         NUMERIC(4,2) DEFAULT 0.65,
  updated_at       TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE rafi_bot_status ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rafi_bot_status_read" ON rafi_bot_status
  FOR SELECT USING (true);

CREATE POLICY "rafi_bot_status_service_write" ON rafi_bot_status
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ── Bot: logs de execução ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rafi_bot_logs (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  level      TEXT        NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error','signal')),
  message    TEXT        NOT NULL,
  details    TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rafi_bot_logs_created ON rafi_bot_logs(created_at DESC);

ALTER TABLE rafi_bot_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rafi_bot_logs_read" ON rafi_bot_logs
  FOR SELECT USING (true);

CREATE POLICY "rafi_bot_logs_service_write" ON rafi_bot_logs
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- ── Bot: fila de comandos (dashboard → executor.py) ───────────────────────────
CREATE TABLE IF NOT EXISTS rafi_bot_commands (
  id         UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  command    TEXT        NOT NULL,   -- ex: 'stop', 'start', 'treinar_xgboost'
  pending    BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rafi_bot_commands_pending ON rafi_bot_commands(pending, created_at DESC);

ALTER TABLE rafi_bot_commands ENABLE ROW LEVEL SECURITY;

-- Qualquer usuário pode inserir comandos; service_role para processar/deletar
CREATE POLICY "rafi_bot_commands_public_insert" ON rafi_bot_commands
  FOR INSERT WITH CHECK (true);

CREATE POLICY "rafi_bot_commands_service_all" ON rafi_bot_commands
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "rafi_bot_commands_read" ON rafi_bot_commands
  FOR SELECT USING (true);

-- ── Bot: configuração da estratégia por perfil (live/simulator) ───────────────
CREATE TABLE IF NOT EXISTS rafi_bot_config (
  profile                  TEXT PRIMARY KEY,   -- 'live' | 'simulator'
  estrategia_modo          TEXT    DEFAULT 'normal',
  forca_limiar             NUMERIC(5,2) DEFAULT 2.5,
  rafi_periodo             INTEGER DEFAULT 14,
  sr_lookback              INTEGER DEFAULT 20,
  swing_stop_lookback      INTEGER DEFAULT 5,
  ma_rapida                INTEGER DEFAULT 9,
  ma_lenta                 INTEGER DEFAULT 21,
  ma_threshold             NUMERIC(6,4) DEFAULT 0.0002,
  bb_filtro_ativo          BOOLEAN DEFAULT TRUE,
  bb_limiar_estreita       NUMERIC(6,4) DEFAULT 0.0020,
  bb_periodo               INTEGER DEFAULT 8,
  bb_desvios               NUMERIC(4,2) DEFAULT 2.0,
  ratio_risco_retorno      NUMERIC(4,2) DEFAULT 1.5,
  max_trades_simultaneos   INTEGER DEFAULT 2,
  autoscan_min_breakout    NUMERIC(6,4) DEFAULT 0.0005,
  autoscan_min_gap_candles INTEGER DEFAULT 3,
  autoscan_stop_offset     NUMERIC(6,4) DEFAULT 0.0003,
  bb_squeeze_expansao_min  NUMERIC(6,4) DEFAULT 0.0005,
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE rafi_bot_config ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rafi_bot_config_read" ON rafi_bot_config
  FOR SELECT USING (true);

CREATE POLICY "rafi_bot_config_service_write" ON rafi_bot_config
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Insere perfis padrão se não existirem
INSERT INTO rafi_bot_config (profile) VALUES ('live')      ON CONFLICT (profile) DO NOTHING;
INSERT INTO rafi_bot_config (profile) VALUES ('simulator') ON CONFLICT (profile) DO NOTHING;

-- ── Configurações de risco (capital, %, limites) ──────────────────────────────
CREATE TABLE IF NOT EXISTS rafi_config_risco (
  id        SERIAL PRIMARY KEY,
  chave     TEXT UNIQUE NOT NULL,
  valor     TEXT NOT NULL,
  descricao TEXT,
  bloqueado BOOLEAN DEFAULT FALSE
);

ALTER TABLE rafi_config_risco ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rafi_config_risco_read" ON rafi_config_risco
  FOR SELECT USING (true);

CREATE POLICY "rafi_config_risco_service_write" ON rafi_config_risco
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Parâmetros padrão (não sobrescreve se já existirem)
INSERT INTO rafi_config_risco (chave, valor, descricao, bloqueado) VALUES
  ('capital_inicial',    '100',  'Capital inicial em USD',                         false),
  ('risco_por_trade_pct','1.0',  '% do capital em risco por trade (ex: 1.0 = 1%)', false),
  ('max_trades_dia',     '5',    'Máximo de trades por dia',                        false),
  ('perda_max_dia_pct',  '5.0',  '% de perda diária que para o bot',                true),
  ('max_trades_simult',  '2',    'Máximo de posições abertas simultaneamente',       true)
ON CONFLICT (chave) DO NOTHING;

-- ── Faixas de lote por capital (escalonamento) ────────────────────────────────
CREATE TABLE IF NOT EXISTS rafi_lote_faixas (
  ordem       INTEGER PRIMARY KEY,
  lote        NUMERIC(8,4) NOT NULL,
  capital_min NUMERIC(10,2) NOT NULL,
  capital_max NUMERIC(10,2),         -- NULL = sem limite superior
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE rafi_lote_faixas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rafi_lote_faixas_read" ON rafi_lote_faixas
  FOR SELECT USING (true);

CREATE POLICY "rafi_lote_faixas_service_write" ON rafi_lote_faixas
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Faixas padrão (não sobrescreve se já existirem)
INSERT INTO rafi_lote_faixas (ordem, lote, capital_min, capital_max) VALUES
  (1, 0.01, 0,    99.99),
  (2, 0.02, 100,  199.99),
  (3, 0.03, 200,  299.99),
  (4, 0.05, 300,  499.99),
  (5, 0.08, 500,  999.99),
  (6, 0.10, 1000, NULL)
ON CONFLICT (ordem) DO NOTHING;

-- ── Corretoras cadastradas ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rafi_brokers (
  id          TEXT PRIMARY KEY,       -- ex: 'pepperstone'
  name        TEXT NOT NULL,
  enabled     BOOLEAN DEFAULT TRUE,
  -- Credenciais MT5 (armazenadas no Supabase, lidas pelo executor.py)
  login       BIGINT,
  servidor    TEXT,
  simbolo     TEXT DEFAULT 'EURUSD',
  mt5_login   BIGINT,
  mt5_senha   TEXT,
  mt5_servidor TEXT,
  mt5_simbolo TEXT,
  mt5_path    TEXT,
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE rafi_brokers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rafi_brokers_read" ON rafi_brokers
  FOR SELECT USING (true);

CREATE POLICY "rafi_brokers_service_write" ON rafi_brokers
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Corretora padrão (não sobrescreve se já existir)
INSERT INTO rafi_brokers (id, name, enabled, simbolo) VALUES
  ('pepperstone', 'Pepperstone', true, 'EURUSD')
ON CONFLICT (id) DO NOTHING;

-- ── Histórico de trades fechados (espelho do MetaAPI, para relatórios) ─────────
CREATE TABLE IF NOT EXISTS rafi_historico (
  id         TEXT PRIMARY KEY,
  symbol     TEXT,
  type       TEXT,    -- 'DEAL_TYPE_BUY' | 'DEAL_TYPE_SELL'
  volume     NUMERIC(8,2),
  price      NUMERIC(10,5),
  profit     NUMERIC(10,2),
  time       TIMESTAMPTZ,
  comment    TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rafi_historico_time ON rafi_historico(time DESC);

ALTER TABLE rafi_historico ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rafi_historico_public_all" ON rafi_historico
  FOR ALL USING (true) WITH CHECK (true);

-- ── Backtest runs (disparados pelo dashboard, executados pelo bot na VPS) ──────
CREATE TABLE IF NOT EXISTS rafi_backtest_runs (
  id           UUID        DEFAULT gen_random_uuid() PRIMARY KEY,
  periodo      TEXT,        -- ex: '30d', '3m', '1y'
  inicio       DATE,
  fim          DATE,
  capital      NUMERIC(10,2) DEFAULT 100.0,
  profile      TEXT DEFAULT 'simulator',
  broker       TEXT DEFAULT 'auto',
  rr_override  NUMERIC(4,2),
  status       TEXT DEFAULT 'pending' CHECK (status IN ('pending','running','done','error','cancelled')),
  progress_pct INTEGER DEFAULT 0 CHECK (progress_pct BETWEEN 0 AND 100),
  config_hash  TEXT,
  resultado    JSONB,       -- stats: win_rate, profit_factor, drawdown, sharpe, etc.
  error_msg    TEXT,
  created_at   TIMESTAMPTZ DEFAULT NOW(),
  updated_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rafi_backtest_runs_status ON rafi_backtest_runs(status, created_at DESC);

ALTER TABLE rafi_backtest_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "rafi_backtest_runs_read" ON rafi_backtest_runs
  FOR SELECT USING (true);

CREATE POLICY "rafi_backtest_runs_service_write" ON rafi_backtest_runs
  FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

-- Qualquer usuário autenticado pode criar/cancelar runs
CREATE POLICY "rafi_backtest_runs_anon_write" ON rafi_backtest_runs
  FOR ALL USING (true) WITH CHECK (true);
