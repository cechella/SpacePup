-- ============================================================
-- Schema Supabase — RAFI Trading Dashboard
-- Execute no SQL Editor do Supabase
-- ============================================================

-- Extensão UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── Perfis de usuário ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS profiles (
  id         UUID REFERENCES auth.users(id) ON DELETE CASCADE PRIMARY KEY,
  role       TEXT NOT NULL DEFAULT 'client' CHECK (role IN ('admin', 'client')),
  name       TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trigger: cria perfil ao registrar usuário
CREATE OR REPLACE FUNCTION handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  INSERT INTO profiles (id, role, name)
  VALUES (NEW.id, 'client', NEW.raw_user_meta_data->>'name');
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION handle_new_user();

-- ── Candles OHLCV ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS candles (
  id         BIGSERIAL PRIMARY KEY,
  symbol     TEXT NOT NULL DEFAULT 'EURUSD',
  timeframe  TEXT NOT NULL DEFAULT 'M5',
  time       TIMESTAMPTZ NOT NULL,
  open       NUMERIC(10,5),
  high       NUMERIC(10,5),
  low        NUMERIC(10,5),
  close      NUMERIC(10,5),
  volume     INTEGER,
  UNIQUE(symbol, timeframe, time)
);

CREATE INDEX IF NOT EXISTS idx_candles_time ON candles(symbol, timeframe, time DESC);

-- ── Sinais RAFI ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS signals (
  id          BIGSERIAL PRIMARY KEY,
  symbol      TEXT NOT NULL DEFAULT 'EURUSD',
  timeframe   TEXT NOT NULL DEFAULT 'M5',
  time        TIMESTAMPTZ NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('buy', 'sell')),
  entry_price NUMERIC(10,5),
  stop_loss   NUMERIC(10,5),
  take_profit NUMERIC(10,5),
  risk_pips   NUMERIC(6,1),
  lot         NUMERIC(8,2),
  status      TEXT DEFAULT 'open' CHECK (status IN ('open', 'win', 'loss')),
  exit_time   TIMESTAMPTZ,
  exit_price  NUMERIC(10,5),
  pnl_pips    NUMERIC(8,1),
  pnl_usd     NUMERIC(10,2),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signals_time ON signals(time DESC);

-- ── Backtest runs ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backtests (
  id           BIGSERIAL PRIMARY KEY,
  run_by       UUID REFERENCES auth.users(id),
  config       JSONB,
  stats        JSONB,
  created_at   TIMESTAMPTZ DEFAULT NOW()
);

-- ── RLS (Row Level Security) ──────────────────────────────────────────────────
ALTER TABLE profiles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE signals   ENABLE ROW LEVEL SECURITY;
ALTER TABLE backtests ENABLE ROW LEVEL SECURITY;
ALTER TABLE candles   ENABLE ROW LEVEL SECURITY;

-- Profiles: cada usuário vê só o seu
CREATE POLICY "profiles_self" ON profiles
  FOR ALL USING (auth.uid() = id);

-- Candles: leitura pública (sem dados sensíveis)
CREATE POLICY "candles_read" ON candles
  FOR SELECT USING (true);

-- Signals: admins veem tudo, clientes só leitura
CREATE POLICY "signals_admin_all" ON signals
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );
CREATE POLICY "signals_client_read" ON signals
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'client')
  );

-- Backtests: só admins
CREATE POLICY "backtests_admin" ON backtests
  FOR ALL USING (
    EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- ── Trades manuais RAFI (dataset de mapeamento para ML) ──────────────────────
CREATE TABLE IF NOT EXISTS rafi_trades (
  id          TEXT PRIMARY KEY,
  direction   TEXT NOT NULL CHECK (direction IN ('buy', 'sell')),
  entry       NUMERIC(10,5) NOT NULL,
  stop_loss   NUMERIC(10,5) NOT NULL,
  take_profit NUMERIC(10,5) NOT NULL,
  label       TEXT,
  time        BIGINT NOT NULL,
  lot         NUMERIC(8,2),
  leverage    INTEGER DEFAULT 1000,
  result      TEXT DEFAULT 'pending' CHECK (result IN ('win', 'loss', 'pending')),
  rafi        NUMERIC(6,3),
  rafi_dir    TEXT CHECK (rafi_dir IN ('bull', 'bear')),
  bb_width    NUMERIC(10,7),
  snapshot    TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rafi_trades_time ON rafi_trades(time DESC);

ALTER TABLE rafi_trades ENABLE ROW LEVEL SECURITY;

-- Dashboard pessoal: leitura e escrita públicas via anon key
CREATE POLICY "rafi_trades_public_all" ON rafi_trades
  FOR ALL USING (true) WITH CHECK (true);

-- ── Dar role admin ao primeiro usuário ───────────────────────────────────────
-- Execute manualmente após criar sua conta:
-- UPDATE profiles SET role = 'admin' WHERE id = (SELECT id FROM auth.users LIMIT 1);
