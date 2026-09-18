-- ============================================================
-- migrate_signals_pending.sql
-- Executar no Supabase SQL Editor após criar a tabela signals_pending
-- ============================================================

-- RLS: bot (anon) pode inserir e ler; executor pode atualizar status
alter table signals_pending enable row level security;

create policy "anon_r" on signals_pending for select to anon using (true);
create policy "anon_i" on signals_pending for insert to anon with check (true);
create policy "anon_u" on signals_pending for update to anon using (true);

-- Índice para o executor buscar sinais pendentes por broker
create index if not exists idx_sp_broker_status
  on signals_pending (broker_id, status, created_at desc);

-- Índice para deduplicação (signal_id é PK, mas esse facilita lookup por tempo)
create index if not exists idx_sp_candle_time
  on signals_pending (candle_time desc);

-- Limpeza automática: remove sinais com mais de 24h
-- (executar como cron job ou Edge Function no Supabase)
-- delete from signals_pending where created_at < now() - interval '24 hours';
