-- ============================================================
-- migrate_broker_health.sql
-- Executar UMA VEZ no Supabase (SQL Editor)
-- Cria as tabelas do Broker Health Engine + configura pesos
--
-- Hierarquia: Admin Panel Config → Supabase → (bot para)
-- Nenhum peso ou threshold está hardcoded no Python.
-- ============================================================


-- ── 1. Configuração do Broker Health Engine ──────────────────
-- Todos os pesos, thresholds e parâmetros de comportamento
-- ficam nesta tabela. O Admin Panel edita aqui; o Python só lê.

create table if not exists broker_health_config (
  chave       text primary key,
  valor       float8 not null,
  descricao   text,
  updated_at  timestamptz default now()
);

alter table broker_health_config enable row level security;
create policy "anon_r" on broker_health_config for select to anon using (true);
create policy "anon_u" on broker_health_config for update to anon using (true);

-- Pesos das 6 dimensões (devem somar 100)
insert into broker_health_config (chave, valor, descricao) values
  ('peso_pnl',           30, 'Peso P&L líquido real (maior — broker que gera mais lucro lidera)'),
  ('peso_spread',        20, 'Peso spread efetivo + comissão convertida em pips'),
  ('peso_execucao',      20, 'Peso qualidade de execução (fill rate, slippage, reject rate)'),
  ('peso_conectividade', 15, 'Peso conectividade e uptime'),
  ('peso_margem',        10, 'Peso margem disponível'),
  ('peso_estabilidade',   5, 'Peso estabilidade do feed de preços'),

  -- Thresholds de estado (score → estado operacional)
  ('threshold_active',          80, 'Score mínimo para estado ACTIVE (alocação plena)'),
  ('threshold_active_reduced',  65, 'Score mínimo para ACTIVE_REDUCED (alocação –50%)'),
  ('threshold_standby',         55, 'Score mínimo para STANDBY (sem novas ordens)'),
  ('threshold_disabled',        40, 'Score abaixo → DISABLED_BY_HEALTH'),

  -- Histerese (evita flapping entre estados)
  ('histerese_n_amostras',       3, 'Amostras consecutivas no novo estado antes de transicionar'),

  -- Circuit Breaker
  ('cb_falhas_para_open',        5, 'Falhas consecutivas para abrir circuit breaker (OPEN)'),
  ('cb_timeout_open_s',        300, 'Segundos em OPEN antes de tentar HALF_OPEN'),
  ('cb_sucessos_para_close',     3, 'Sucessos em HALF_OPEN para fechar (CLOSED)'),

  -- Alocação dinâmica
  ('max_allocation_pct',        55, 'Percentual máximo de alocação por broker (0–100)'),
  ('min_trades_confianca',      20, 'Trades mínimos para score de P&L ser considerado confiável'),

  -- Coleta de métricas
  ('intervalo_coleta_s',        60, 'Segundos entre coletas de métricas por broker'),
  ('telemetria_max_age_s',     120, 'Segundos máximos sem coleta → score zerado (stale telemetry)'),

  -- Quarentena automática
  ('quarentena_minutos',        30, 'Duração mínima de quarentena após evento severo'),

  -- Janelas de análise para P&L (em número de trades)
  ('pnl_janela_trades',         50, 'Quantidade de trades recentes para cálculo de P&L médio'),

  -- Anomalia (EMA + desvios)
  ('anomalia_desvios',           2, 'Desvios padrão acima da EMA para detectar spike anômalo')

on conflict (chave) do nothing;


-- ── 2. Métricas coletadas por broker (série temporal) ────────
-- Uma linha por coleta (a cada ~60s por broker ativo).
-- Retenção sugerida: 7 dias (excluir via pg_cron ou Edge Function).

create table if not exists broker_health_metrics (
  id                      uuid primary key default gen_random_uuid(),
  broker_id               text not null references rafi_brokers(id) on delete cascade,
  coletado_em             timestamptz not null default now(),

  -- Grupo A: Conectividade
  connection_status       boolean,
  heartbeat_latency_ms    float8,
  api_response_time_ms    float8,
  disconnect_count        integer  default 0,
  reconnect_frequency     float8   default 0,
  uptime_pct              float8   default 100,

  -- Grupo B: Execução de ordens
  order_execution_time_ms float8,
  fill_rate_pct           float8,
  partial_fill_rate_pct   float8   default 0,
  reject_rate_pct         float8   default 0,
  requote_rate_pct        float8   default 0,
  timeout_rate_pct        float8   default 0,
  api_error_rate_pct      float8   default 0,

  -- Grupo C: Spread & custo
  spread_pips             float8,
  effective_spread_pips   float8,
  slippage_pips           float8   default 0,
  commission_per_lot      float8   default 0,

  -- Grupo D: P&L real
  pnl_liquido_medio_usd   float8   default 0,
  pnl_por_pip_usd         float8   default 0,
  custo_total_pips        float8,

  -- Grupo E: Margem & capacidade
  free_margin_usd         float8,
  margin_level_pct        float8,
  price_feed_delay_ms     float8,
  price_feed_stability    float8,

  -- Metadados
  metricas_indisponiveis  text[]   default '{}'
);

alter table broker_health_metrics enable row level security;
create policy "anon_r" on broker_health_metrics for select to anon using (true);
create policy "anon_i" on broker_health_metrics for insert to anon with check (true);

-- Índice para queries por broker + tempo (cálculo de janelas)
create index if not exists idx_bhm_broker_tempo
  on broker_health_metrics (broker_id, coletado_em desc);


-- ── 3. Scores calculados (histórico) ─────────────────────────
-- Uma linha por ciclo de cálculo por broker.

create table if not exists broker_health_scores (
  id                    uuid primary key default gen_random_uuid(),
  broker_id             text not null references rafi_brokers(id) on delete cascade,
  calculado_em          timestamptz not null default now(),

  health_score          float8 not null,       -- 0–100 composite
  dim_pnl               float8,                -- contribuição de cada dimensão
  dim_spread            float8,
  dim_execucao          float8,
  dim_conectividade     float8,
  dim_margem            float8,
  dim_estabilidade      float8,

  amostra_insuficiente  boolean default false, -- true se < min_trades_confianca
  anomalia_ativa        boolean default false  -- penalidade de 15% aplicada
);

alter table broker_health_scores enable row level security;
create policy "anon_r" on broker_health_scores for select to anon using (true);
create policy "anon_i" on broker_health_scores for insert to anon with check (true);

create index if not exists idx_bhs_broker_tempo
  on broker_health_scores (broker_id, calculado_em desc);


-- ── 4. Estado atual por broker (uma linha por broker) ────────
-- Atualizada a cada ciclo de avaliação.

create table if not exists broker_health_state (
  broker_id           text primary key references rafi_brokers(id) on delete cascade,
  estado              text not null default 'STANDBY',
  -- valores: ACTIVE | ACTIVE_REDUCED | STANDBY | QUARANTINED | DISABLED_BY_HEALTH | MANUALLY_DISABLED
  estado_anterior     text,
  circuit_breaker     text not null default 'CLOSED',
  -- valores: CLOSED | OPEN | HALF_OPEN
  health_score        float8 default 0,
  consecutivos_ok     integer default 0,   -- amostras consecutivas acima do threshold
  consecutivos_ruim   integer default 0,   -- amostras consecutivas abaixo do threshold
  quarentena_ate      timestamptz,         -- nulo = sem quarentena ativa
  override_manual     text,               -- 'MANUAL_ACTIVE' | 'MANUAL_DISABLED' | nulo
  motivo_estado       text,               -- descrição legível do último evento
  atualizado_em       timestamptz default now()
);

alter table broker_health_state enable row level security;
create policy "anon_r" on broker_health_state for select to anon using (true);
create policy "anon_i" on broker_health_state for insert to anon with check (true);
create policy "anon_u" on broker_health_state for update to anon using (true);

-- Inicializa estado para brokers já cadastrados
insert into broker_health_state (broker_id, estado, circuit_breaker)
  select id, 'STANDBY', 'CLOSED' from rafi_brokers
on conflict (broker_id) do nothing;


-- ── 5. Novas colunas em rafi_brokers ─────────────────────────
-- Adiciona campos de health ao cartão de cada broker no dashboard.

alter table rafi_brokers
  add column if not exists health_score     float8   default 0,
  add column if not exists health_estado    text     default 'STANDBY',
  add column if not exists allocation_pct   float8   default 0,
  add column if not exists broker_priority  integer  default 99;

-- Prioridade inicial das 3 corretoras piloto
update rafi_brokers set broker_priority = 1 where id = 'exness';
update rafi_brokers set broker_priority = 2 where id = 'tickmill';
update rafi_brokers set broker_priority = 3 where id = 'pepperstone';

-- ── FIM DA MIGRAÇÃO ──────────────────────────────────────────
-- Após executar, verifique as tabelas criadas no Supabase:
--   select * from broker_health_config order by chave;
--   select * from broker_health_state;
