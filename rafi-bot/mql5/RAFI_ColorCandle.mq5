//+------------------------------------------------------------------+
//| RAFI_ColorCandle.mq5                                             |
//| Velas coloridas pelo índice de força RAFI                        |
//| Verde   = RAFI ≥ +2.5 + candle de alta  (força forte)           |
//| Vermelho = RAFI ≥ +2.5 + candle de baixa (força forte)          |
//| Amarelo = exaustão (|RAFI prev| ≥ 2.5 e |RAFI atual| < 1.0)     |
//| Cinza   = consolidação (|RAFI| < 2.5)                            |
//+------------------------------------------------------------------+
#property copyright   "RAFI Bot"
#property version     "1.00"
#property description "Velas coloridas pelo índice de força RAFI"

#property indicator_chart_window
#property indicator_buffers 7
#property indicator_plots   1

#property indicator_label1  "RAFI Candle"
#property indicator_type1   DRAW_COLOR_CANDLES
#property indicator_style1  STYLE_SOLID
#property indicator_width1  1

// Índice de cor: 0=Cinza | 1=Verde | 2=Vermelho | 3=Amarelo
#property indicator_color1  clrDarkGray     // 0 — consolidação
#property indicator_color2  clrLimeGreen    // 1 — alta forte
#property indicator_color3  clrTomato       // 2 — baixa forte
#property indicator_color4  clrGoldenrod    // 3 — exaustão

input int InpATRPeriod  = 14; // Período ATR (suavização Wilder)
input int InpRAFIPeriod =  3; // Janela de momentum (candles atrás)

// Buffers OHLC — DRAW_COLOR_CANDLES exige esta ordem exata
double CandleOpen[];
double CandleHigh[];
double CandleLow[];
double CandleClose[];

// Buffer de índice de cor (INDICATOR_COLOR_INDEX)
double ColorIndex[];

// Buffers de cálculo interno — não aparecem no gráfico
double ATRBuffer[];
double RAFIBuffer[];

//+------------------------------------------------------------------+
int OnInit()
{
   // ── Buffers de dados do candle ───────────────────────────────────
   SetIndexBuffer(0, CandleOpen,  INDICATOR_DATA);
   SetIndexBuffer(1, CandleHigh,  INDICATOR_DATA);
   SetIndexBuffer(2, CandleLow,   INDICATOR_DATA);
   SetIndexBuffer(3, CandleClose, INDICATOR_DATA);

   // ── Buffer de cor ────────────────────────────────────────────────
   SetIndexBuffer(4, ColorIndex,  INDICATOR_COLOR_INDEX);

   // ── Buffers de cálculo (invisíveis) ─────────────────────────────
   SetIndexBuffer(5, ATRBuffer,   INDICATOR_CALCULATIONS);
   SetIndexBuffer(6, RAFIBuffer,  INDICATOR_CALCULATIONS);

   PlotIndexSetDouble(0, PLOT_EMPTY_VALUE, 0.0);
   IndicatorSetString(INDICATOR_SHORTNAME, "RAFI Candle");
   IndicatorSetInteger(INDICATOR_DIGITS, _Digits);

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

   // ── RAFI (magnitude com sinal) ───────────────────────────────────
   // Idêntico ao calcRAFI() em lib/indicators.ts
   // valor positivo = alta | negativo = baixa
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

   // ── Copia OHLC e aplica cor ──────────────────────────────────────
   // Idêntico ao applyRAFICandleColors() em lib/indicators.ts
   int colorStart = MathMax(calcStart, 1); // precisa de i-1 para exaustão

   for(int i = colorStart; i < rates_total; i++)
   {
      CandleOpen[i]  = open[i];
      CandleHigh[i]  = high[i];
      CandleLow[i]   = low[i];
      CandleClose[i] = close[i];

      double rafiCurr = RAFIBuffer[i];
      double rafiPrev = RAFIBuffer[i - 1];

      // Exaustão: força forte no anterior, colapso brusco agora
      bool exhaustion = (MathAbs(rafiPrev) >= 2.5) && (MathAbs(rafiCurr) < 1.0);

      if(exhaustion)
         ColorIndex[i] = 3;                           // amarelo — exaustão
      else if(MathAbs(rafiCurr) >= 2.5)
         ColorIndex[i] = (rafiCurr > 0) ? 1 : 2;     // verde ou vermelho
      else
         ColorIndex[i] = 0;                           // cinza — consolidação
   }

   return rates_total;
}
//+------------------------------------------------------------------+
