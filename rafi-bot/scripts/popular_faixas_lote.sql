-- popular_faixas_lote.sql
-- Execute no SQL Editor do Supabase:
--   https://supabase.com/dashboard/project/fvvxwycdeirjenaytqif/sql/new
--
-- Restaura a tabela rafi_lote_faixas com o escalonamento de lotes oficial.

-- Limpa entradas anteriores (se existirem)
DELETE FROM rafi_lote_faixas;

-- Insere 12 faixas conforme especificação do trader
INSERT INTO rafi_lote_faixas (ordem, capital_min, capital_max, lote, ativo) VALUES
  ( 1,      0,     40,   0.10, true),
  ( 2,     40,     80,   0.20, true),
  ( 3,     80,    150,   0.40, true),
  ( 4,    150,    200,   0.70, true),
  ( 5,    200,    400,   1.00, true),
  ( 6,    400,    800,   2.00, true),
  ( 7,    800,   1500,   4.00, true),
  ( 8,   1500,   3000,   8.00, true),
  ( 9,   3000,   6000,  15.00, true),
  (10,   6000,  10000,  30.00, true),
  (11,  10000,  20000,  50.00, true),
  (12,  20000,   NULL, 100.00, true);  -- NULL = sem limite (∞)

-- Confirma resultado
SELECT ordem, capital_min, capital_max, lote, ativo
FROM rafi_lote_faixas
ORDER BY ordem;
