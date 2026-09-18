-- ── Migração: FOREX.com (StoneX) ────────────────────────────────────────────
-- Execute no Supabase SQL Editor

-- Cadastra FOREX.com
INSERT INTO rafi_brokers (
  id, nome, tipo, login, servidor, simbolo,
  mt5_login, mt5_servidor, mt5_simbolo,
  mt5_path,
  enabled, broker_priority,
  health_estado, saldo
) VALUES (
  'forex_com',
  'FOREX.com',
  'Raw Spread STP',
  24366891,
  'Forex.com-Live 532',
  'EURUSD',
  24366891,
  'Forex.com-Live 532',
  'EURUSD',
  'C:\Program Files\MetaTrader 5 FOREX.com\terminal64.exe',
  false,   -- desligado até depositar e ativar
  40,      -- prioridade após Pepperstone (10) e Fusion (30)
  'STANDBY',
  0.00
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

-- Entrada de saúde
INSERT INTO broker_health_state (broker_id, estado, circuit_breaker, health_score)
VALUES ('forex_com', 'STANDBY', 'CLOSED', 0)
ON CONFLICT (broker_id) DO NOTHING;

-- Verificação
SELECT id, nome, tipo, enabled, mt5_login, mt5_servidor, broker_priority
FROM rafi_brokers
ORDER BY broker_priority;
