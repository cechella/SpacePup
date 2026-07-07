# PROJETO: Bot Forex RAFI + Machine Learning

Corretora XM · MetaTrader 5 · EURUSD · Google Cloud

Documento mestre do projeto (contexto completo para o Claude Code).
O código do bot vive em `rafi-bot/`. Todo o código deve ser bem comentado **em português**.

## 1. Visão geral

Bot de trading automatizado para Forex (par principal: **EURUSD**), operando na corretora
**XM via MetaTrader 5**, baseado na estratégia do indicador **RAFI** (Raphael Figueredo)
de rompimento de suportes/resistências, com filtro de **Machine Learning (classificador)**
na Fase 2.

### Contexto do dono do projeto

- Trader com resultados positivos em day trade manual de EURUSD na XM (posições de minutos a horas)
- Estilo: rompimentos intraday — não é scalping de milissegundos (latência não é crítica)
- Infraestrutura alvo: VM Windows Server no Google Cloud (região europe-west2 / Londres), 24/7
- Conhecimento técnico intermediário; o código deve ser bem comentado em português

## 2. A estratégia (manuais RAFI — Módulos 1 e 2)

### 2.1 O indicador RAFI

- Indicador de "market breadth" em histograma que valida rompimentos
- Leitura: > +2,50 = super forte | 0 a +2,49 = forte | 0 a -2,49 = fraco | < -2,50 = super fraco
- A fórmula exata é proprietária (Profitchart/Bloomberg). Foi criada uma **aproximação**
  ("índice de força"): momentum normalizado + amplitude do candle vs. média + volume relativo,
  calibrada para disparar nos mesmos pontos
- O RAFI mede a **força do movimento** (magnitude), não a direção: um rompimento de
  resistência com RAFI > +2,50 valida COMPRA; um rompimento de suporte com RAFI > +2,50
  valida VENDA
- "Candle amarelo" (exaustão): RAFI > +2,50 no candle anterior e < -2,50 no candle seguinte

### 2.2 Regras de ENTRADA

**COMPRA:**
1. Preço rompe uma RESISTÊNCIA relevante (topo dos últimos N candles / pivô)
2. Índice de força > limiar (equivalente ao RAFI > +2,50) no candle do rompimento
3. Sincronismo multi-timeframe: M5, M15 e H1 apontando a MESMA direção (alta) —
   tendência definida por topos/fundos ascendentes e/ou médias móveis
4. Bandas de Bollinger (8 períodos, 2 desvios) estavam ESTREITAS e estão ABRINDO — timing de entrada

**VENDA:** espelho exato (rompe SUPORTE com força + 3 timeframes em baixa + Bollinger abrindo para baixo).

### 2.3 Regras de NÃO OPERAR (filtros críticos)

- Timeframes conflitantes (ex.: M5 em alta, M15/H1 laterais) → NÃO OPERA
- Mercado sem tendência definida (lateralidade) → NÃO OPERA
- Nunca comprar quando a força está alta mas rompendo SUPORTE (sinal invertido)

### 2.4 Regras de SAÍDA

- Stop-loss: abaixo do suporte rompido (venda: acima da resistência) — SEMPRE presente
- Take-profit: razão risco/retorno mínima 1:1,5 (parametrizável)
- Exaustão ("candle amarelo"): força vai de > +2,50 para < -2,50 em candles consecutivos →
  fechar posição ou apertar trailing stop
- Trailing stop opcional após 1R de lucro

### 2.5 Gestão de risco (INEGOCIÁVEL)

- Risco máximo por trade: 1-2% do capital (parametrizável)
- Máximo de trades simultâneos: 2
- Perda máxima diária: 5% → bot para de operar até o dia seguinte
- Sem martingale, sem grid, sem dobrar posição após perda
- Alavancagem efetiva conservadora (sugerido: máx. 1:50, mesmo que a conta permita 1:888)

## 3. Arquitetura e stack

### 3.1 Stack

- **Python 3.11+** com biblioteca `MetaTrader5` (conexão direta com o terminal MT5 da XM)
- `pandas`, `numpy` — dados e indicadores
- `scikit-learn` + `xgboost` — classificador ML (Fase 2)
- `pytest` — testes unitários das regras
- Logging estruturado (arquivo + console) de TODAS as decisões (sinais aceitos E descartados)

### 3.2 Estrutura de pastas

```
rafi-bot/
├── config.yaml            # parâmetros: par, risco, limiares, horários
├── requirements.txt
├── run_backtest.py        # ponto de entrada do backtest (CLI)
├── src/
│   ├── mt5_client.py      # conexão, dados, envio de ordens (MT5/XM)
│   ├── indicators.py      # índice de força (RAFI aprox.), Bollinger, S/R
│   ├── strategy.py        # regras de entrada/saída/filtros (seção 2)
│   ├── multi_timeframe.py # sincronismo M5/M15/H1
│   ├── risk_manager.py    # position sizing, limites, stops
│   ├── executor.py        # loop principal: analisa → decide → executa
│   └── ml/
│       ├── feature_builder.py # features de cada sinal (Fase 2)
│       ├── train.py           # treino/retreino do classificador
│       └── predictor.py       # filtro de probabilidade em produção
├── backtest/
│   ├── engine.py          # backtesting com dados históricos do MT5
│   └── report.py          # win rate, profit factor, drawdown, Sharpe
├── scripts/
│   └── baixar_dados.py    # download/normalização de dados históricos
├── data/                  # históricos, sinais rotulados
├── logs/
└── tests/
```

### 3.3 Fases do projeto (ordem obrigatória)

- **FASE 1A — Núcleo:** indicadores + regras + backtest engine. Validar em 2-3 anos de
  histórico EURUSD (M5). Meta: win rate > 55% e profit factor > 1,5 no backtest
- **FASE 1B — Demo:** conta DEMO da XM por 1-2 meses; comparar com o backtest
- **FASE 1C — Live:** conta real com capital reduzido (20-30% do planejado)
- **FASE 2 — ML:** com 300+ sinais rotulados, treinar classificador (XGBoost) que estima
  P(sucesso) de cada rompimento. Features: índice de força, largura das Bollinger,
  nº de timeframes alinhados, sessão (Londres/NY/Ásia), hora, dia da semana, ATR,
  distância do último topo/fundo, spread. Filtro: só opera se P(sucesso) ≥ 65%
  (parametrizável). Validação walk-forward; retreino mensal

### 3.4 Deploy (Google Cloud)

- VM Windows Server 2022, e2-medium ou superior, região **europe-west2 (Londres)**
- MT5 da XM + Python; bot como serviço/tarefa agendada com auto-restart
- Watchdog: se o bot cair, reiniciar e notificar (e-mail/Telegram)
- Kill switch manual documentado (parar tudo com 1 comando)

## 4. Avisos importantes para o desenvolvimento

- **Backtest honesto:** incluir spread real da XM (~0,6-1,6 pips EURUSD), slippage estimado
  e comissões. Sem lookahead bias (decisão só com dados disponíveis no fechamento do candle)
- **Overfitting é o inimigo nº 1:** poucos parâmetros, validação out-of-sample sempre,
  desconfiar de win rate > 80% em backtest
- **O bot NUNCA opera sem stop-loss** — validar no código antes de enviar qualquer ordem

> Resultados passados não garantem lucro futuro; o projeto é um estudo aplicado com
> gestão de risco rigorosa.
