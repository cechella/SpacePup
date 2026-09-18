//+------------------------------------------------------------------+
//| RAFI_Histograma.mq5                                              |
//| Aproximação do índice de força RAFI                              |
//| Fórmula: momentum normalizado + amplitude do candle vs ATR       |
//| Valores: positivo = força de alta | negativo = força de baixa    |
//| Limiares: ≥ +2.5 forte alta | ≤ -2.5 forte baixa                |
//+------------------------------------------------------------------+
#property copyright   "RAFI Bot"
#property version     "1.00"
#property description "Índice de força RAFI — aproximação (momentum + amplitude vs ATR)"

#property indicator_separate_window
#property indicator_buffers 2
#property indicator_plots   1

#property indicator_label1  "RAFI"
#property indicator_type1   DRAW_HISTOGRAM
#property indicator_color1  clrGoldenrod
#property indicator_style1  STYLE_SOLID
#property indicator_width1  2

// Linhas de referência ±2.5
#property indicator_level1   2.5
#property indicator_level2  -2.5
#property indicator_levelcolor clrDimGray
#property indicator_levelstyle STYLE_DOT
#property indicator_levelwidth  1

input int InpATRPeriod  = 14; // Período ATR (suavização Wilder)
input int InpRAFIPeriod =  3; // Janela de momentum (candles atrás)

double RAFIBuffer[];   // buffer principal — visível no gráfico
double ATRBuffer[];    // buffer intermediário — ATR de Wilder

//+------------------------------------------------------------------+
int OnInit()
{
   SetIndexBuffer(0, RAFIBuffer, INDICATOR_DATA);
   SetIndexBuffer(1, ATRBuffer,  INDICATOR_CALCULATIONS);

   PlotIndexSetDouble(0, PLOT_EMPTY_VALUE, 0.0);
   IndicatorSetString(INDICATOR_SHORTNAME, "RAFI");
   IndicatorSetInteger(INDICATOR_DIGITS, 2);

   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
int OnCalculate(const int rates_total,
                const int prev_calculated,
                const datetime &time[],
                const double &open[],
                const double &high[],
                const double &low[],
                const double &close[],
                const long &tick_volume[],
                const long &volume[],
                const int &spread[])
{
   if(rates_total < InpATRPeriod + InpRAFIPeriod + 1)
      return 0;

   // ── ATR de Wilder ────────────────────────────────────────────────
   // Idêntico ao calcATR() em lib/indicators.ts
   int atrStart = (prev_calculated <= InpATRPeriod) ? 1 : prev_calculated - 1;

   if(prev_calculated <= InpATRPeriod)
   {
      ATRBuffer[0] = 0;
      double sumTR = 0;
      for(int i = 1; i <= InpATRPeriod && i < rates_total; i++)
      {
         double tr = MathMax(high[i] - low[i],
                    MathMax(MathAbs(high[i] - close[i-1]),
                            MathAbs(low[i]  - close[i-1])));
         sumTR += tr;
      }
      if(InpATRPeriod < rates_total)
         ATRBuffer[InpATRPeriod] = sumTR / InpATRPeriod;
      atrStart = InpATRPeriod + 1;
   }

   for(int i = atrStart; i < rates_total; i++)
   {
      double tr = MathMax(high[i] - low[i],
                 MathMax(MathAbs(high[i] - close[i-1]),
                         MathAbs(low[i]  - close[i-1])));
      ATRBuffer[i] = (ATRBuffer[i-1] * (InpATRPeriod - 1) + tr) / InpATRPeriod;
   }

   // ── RAFI ─────────────────────────────────────────────────────────
   // Idêntico ao calcRAFI() em lib/indicators.ts
   // mom   = |close[i] - close[i-period]| / close[i-period] * 100
   // amp   = |close[i] - open[i]| / ATR[i]
   // mag   = min(5, mom * 25 + amp * 3)
   // valor = +mag (alta) ou -mag (baixa)
   int calcStart = MathMax(atrStart, MathMax(InpATRPeriod, InpRAFIPeriod));

   for(int i = calcStart; i < rates_total; i++)
   {
      int prevIdx = i - InpRAFIPeriod;
      if(prevIdx < 0 || close[prevIdx] == 0) { RAFIBuffer[i] = 0; continue; }

      double mom  = MathAbs(close[i] - close[prevIdx]) / close[prevIdx] * 100.0;
      double body = MathAbs(close[i] - open[i]);
      double amp  = ATRBuffer[i] > 0 ? body / ATRBuffer[i] : 0;
      double mag  = MathMin(5.0, mom * 25.0 + amp * 3.0);

      bool bull = close[i] >= open[i];
      RAFIBuffer[i] = bull ? mag : -mag;
   }

   return rates_total;
}
//+------------------------------------------------------------------+
