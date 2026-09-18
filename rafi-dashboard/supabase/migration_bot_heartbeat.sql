-- Adiciona coluna bot_heartbeat_at à rafi_brokers
-- Atualizada SOMENTE pelo bot (publicar_status_broker) — nunca pelo dashboard.
-- Permite detectar se o bot está offline mesmo quando updated_at foi tocado por toggle de configuração.

ALTER TABLE rafi_brokers
  ADD COLUMN IF NOT EXISTS bot_heartbeat_at timestamptz DEFAULT NULL;

-- Reseta status de bots que ficaram com status ativo mas não estão rodando
UPDATE rafi_brokers
  SET status_text = 'DESLIGADA'
  WHERE status_text IN ('AGUARDANDO SINAL', 'OPERANDO', 'PARADO');
