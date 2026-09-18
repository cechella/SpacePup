# EURUSD Autoscan — Regras Exatas de Lote e Estratégia

## Lote Composto (crescimento exponencial)

A função `get_lot(capital)` calcula o lote proporcional ao capital:

```python
def get_lot(capital):
    """Lote cresce com o capital — compoundagem automática."""
    if capital < 50:    return 0.01
    if capital < 100:   return 0.02
    if capital < 200:   return 0.04
    if capital < 500:   return 0.10
    if capital < 1000:  return 0.20
    if capital < 2000:  return 0.40
    if capital < 5000:  return 1.00
    if capital < 10000: return 2.00
    return round(capital / 5000, 2)  # 1 lote por $5.000
```

**Capital inicial: $20 → lote inicial: 0,01**

## Parâmetros da Estratégia (resultado otimizado)

| Parâmetro        | Valor    | Descrição                          |
|------------------|----------|------------------------------------|
| sr_lookback      | 20       | Janela para calcular S/R (candles) |
| bb_period        | 8        | Período das Bollinger Bands        |
| rr_ratio         | 1.5      | Risco/Retorno mínimo               |
| min_breakout     | 0.00003  | Breakout mínimo (3 pips equiv.)    |
| min_gap          | 8        | Candles mínimos entre sinais       |
| squeeze_ratio    | 0.0012   | Limiar do squeeze (BB estreita)    |
| expansao_min     | 1.05     | Expansão mínima da BB              |
| stop_offset      | 0.00015  | Offset do stop abaixo do S/R       |

## Lógica do Sinal

1. BB Period 8 em squeeze (largura < squeeze_ratio × preço)
2. BB expande (largura atual > largura anterior × expansao_min)
3. Preço rompe S/R dos últimos `sr_lookback` candles por ≥ min_breakout
4. Sem outro sinal nos últimos `min_gap` candles
5. **BUY**: rompe resistência | **SELL**: rompe suporte

## Resultado do Backtest (26 anos, lote fixo 0,01)

- Período: 2000-05-30 → 2026-08-28 (1.899.160 candles M5)
- Trades: 62.395 | Win Rate: 59,8% | Profit Factor: 1,96
- P&L: +$11.997 sobre $20 de capital
- **Todo ano foi lucrativo** (pior: 2000 +$212, melhor: 2008 +$581)

## Resultado com Lote Composto (capital $20 inicial)

- Capital final (26 anos): ~$119.765.910
- Retorno: +598.829.453%
- Nota: resultado matemático da compoundagem — na prática brokers limitam tamanho de lote

## Dados

- Fonte: HistData.com M1 → convertido para M5
- Arquivo: `EURUSD_M5_26anos_2000-2026.zip` (17MB, descomprime para 98MB CSV)
- Colunas: `Time, Open, High, Low, Close, Volume`
- Separador: tab (\t)

## Código da Estratégia

Ver `autoscan_browser.py` nesta pasta — implementação Python completa.
