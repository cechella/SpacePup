-- Tabela de configuração da IA Autônoma — executar no Supabase SQL Editor

CREATE TABLE IF NOT EXISTS rafi_ia_config (
  id                    TEXT PRIMARY KEY DEFAULT 'default',
  ia_autonoma_ativa     BOOLEAN NOT NULL DEFAULT true,
  sessao_sydney_tokyo   BOOLEAN NOT NULL DEFAULT true,
  sessao_tokyo_london   BOOLEAN NOT NULL DEFAULT true,
  meta_diaria_pct       NUMERIC(4, 2) NOT NULL DEFAULT 7.00,
  meta_semanal_pct      NUMERIC(5, 2) NOT NULL DEFAULT 25.00,
  threshold_confianca   NUMERIC(4, 2) NOT NULL DEFAULT 0.65,
  updated_at            TIMESTAMPTZ DEFAULT now()
);

-- Insere linha padrão se não existir
INSERT INTO rafi_ia_config (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;
