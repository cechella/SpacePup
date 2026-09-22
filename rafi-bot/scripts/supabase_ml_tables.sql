-- Tabelas para XGBoost ML — executar uma vez no Supabase SQL Editor

-- Armazena importância de cada feature após cada retreino
CREATE TABLE IF NOT EXISTS rafi_feature_importances (
  feature     TEXT PRIMARY KEY,
  importance  NUMERIC(8, 6) NOT NULL DEFAULT 0,
  rank        INTEGER,
  n_trades    INTEGER,
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Armazena métricas do modelo treinado
CREATE TABLE IF NOT EXISTS rafi_ml_models (
  id          TEXT PRIMARY KEY DEFAULT 'xgboost_v1',
  n_trades    INTEGER,
  wr_raw      NUMERIC(5, 4),
  wr_filtrado NUMERIC(5, 4),
  auc_roc     NUMERIC(5, 4),
  threshold   NUMERIC(4, 2),
  treinado_em TIMESTAMPTZ DEFAULT now()
);
