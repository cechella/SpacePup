//+------------------------------------------------------------------+
//| RAFI_ColorCandle.mq5                                             |
//| Velas coloridas pelo índice de força RAFI                        |
//| Verde   = RAFI ≥ limiar + candle de alta  (força forte)         |
//| Vermelho = RAFI ≥ limiar + candle de baixa (força forte)        |
//| Amarelo = exaustão (mag anterior ≥ limiar e mag atual < 40%)    |
//| Cinza   = consolidação (RAFI < limiar)                          |
//+------------------------------------------------------------------+
#property copyright   "RAFI Bot"
#property version     "1.07"
#property description "Velas coloridas pelo índice de força RAFI"

#property indicator_chart_window
#property indicator_buffers 7
#property indicator_plots   1

#property indicator_label1  "RAFI Candle"
#property indicator_type1   DRAW_COLOR_CANDLES
#property indicator_style1  STYLE_SOLID
#property indicator_width1  1

// Índice de cor: 0=Cinza | 1=Verde | 2=Vermelho | 3=Amarelo
#property indicator_color1  clrGray
#property indicator_color2  clrLimeGreen
#property indicator_color3  clrRed
#property indicator_color4  clrYellow

input int    InpATRPeriod  = 14;
input int    InpRAFIPeriod =  3;
input double InpThreshold  = 1.0;

double CandleOpen[];
double CandleHigh[];
double CandleLow[];
double CandleClose[];
double ColorIndex[];
double ATRBuffer[];
double RAFIBuffer[];

// Cores originais do gráfico
color g_Bull, g_Bear, g_Up, g_Down;

int OnInit()
{
   SetIndexBuffer(0, CandleOpen,  INDICATOR_DATA);
   SetIndexBuffer(1, CandleHigh,  INDICATOR_DATA);
   SetIndexBuffer(2, CandleLow,   INDICATOR_DATA);
   SetIndexBuffer(3, CandleClose, INDICATOR_DATA);
   SetIndexBuffer(4, ColorIndex,  INDICATOR_COLOR_INDEX);
   SetIndexBuffer(5, ATRBuffer,   INDICATOR_CALCULATIONS);
   SetIndexBuffer(6, RAFIBuffer,  INDICATOR_CALCULATIONS);

   PlotIndexSetDouble(0, PLOT_EMPTY_VALUE, 0.0);
   IndicatorSetString(INDICATOR_SHORTNAME, "RAFI Candle");
   IndicatorSetInteger(INDICATOR_DIGITS, _Digits);

   // Salva cores originais e esconde candles do gráfico
   g_Bull = (color)ChartGetInteger(0, CHART_COLOR_CANDLE_BULL);
   g_Bear = (color)ChartGetInteger(0, CHART_COLOR_CANDLE_BEAR);
   g_Up   = (color)ChartGetInteger(0, CHART_COLOR_CHART_UP);
   g_Down = (color)ChartGetInteger(0, CHART_COLOR_CHART_DOWN);

   color bg = (color)ChartGetInteger(0, CHART_COLOR_BACKGROUND);
   ChartSetInteger(0, CHART_COLOR_CANDLE_BULL, bg);
   ChartSetInteger(0, CHART_COLOR_CANDLE_BEAR, bg);
   ChartSetInteger(0, CHART_COLOR_CHART_UP,    bg);
   ChartSetInteger(0, CHART_COLOR_CHART_DOWN,  bg);
   ChartRedraw(0);

   Comment("RAFI v1.07 iniciando...");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   // Restaura cores originais ao remover o indicador
   ChartSetInteger(0, CHART_COLOR_CANDLE_BULL, g_Bull);
   ChartSetInteger(0, CHART_COLOR_CANDLE_BEAR, g_Bear);
   ChartSetInteger(0, CHART_COLOR_CHART_UP,    g_Up);
   ChartSetInteger(0, CHART_COLOR_CHART_DOWN,  g_Down);
   ChartRedraw(0);
   Comment("");
}

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

   // ATR de Wilder (incremental)
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

   // RAFI (magnitude absoluta, incremental)
   int calcStart = MathMax(atrStart, MathMax(InpATRPeriod, InpRAFIPeriod));

   for(int i = calcStart; i < rates_total; i++)
   {
      int prevIdx = i - InpRAFIPeriod;
      if(prevIdx < 0 || close[prevIdx] == 0) { RAFIBuffer[i] = 0; continue; }

      double mom  = MathAbs(close[i] - close[prevIdx]) / close[prevIdx] * 100.0;
      double body = MathAbs(close[i] - open[i]);
      double amp  = ATRBuffer[i] > 0 ? body / ATRBuffer[i] : 0;
      RAFIBuffer[i] = MathMin(5.0, mom * 25.0 + amp * 3.0);
   }

   // Cores — loop não-incremental (garante que InpThreshold reflita em todo histórico)
   int minStart = InpATRPeriod + InpRAFIPeriod + 1;

   for(int i = minStart; i < rates_total; i++)
   {
      CandleOpen[i]  = open[i];
      CandleHigh[i]  = high[i];
      CandleLow[i]   = low[i];
      CandleClose[i] = close[i];

      double mag     = RAFIBuffer[i];
      double magPrev = RAFIBuffer[i - 1];
      bool   isBull  = (close[i] >= open[i]);

      bool exhaustion = (magPrev >= InpThreshold) && (mag < InpThreshold * 0.4);

      if(exhaustion)
         ColorIndex[i] = 3;
      else if(mag >= InpThreshold)
         ColorIndex[i] = isBull ? 1.0 : 2.0;
      else
         ColorIndex[i] = 0;
   }

   // Diagnóstico: mostra valores do último candle e de 20 candles atrás
   int last = rates_total - 1;
   int prev = last - 20;
   string diag = "RAFI v1.07";
   diag += "\nULTIMO: mag=" + DoubleToString(RAFIBuffer[last], 4)
         + " ATR=" + DoubleToString(ATRBuffer[last], 5)
         + " cor=" + IntegerToString((int)ColorIndex[last])
         + " alta=" + (close[last] >= open[last] ? "SIM" : "NAO");
   if(prev >= minStart)
      diag += "\n-20bars: mag=" + DoubleToString(RAFIBuffer[prev], 4)
            + " ATR=" + DoubleToString(ATRBuffer[prev], 5)
            + " cor=" + IntegerToString((int)ColorIndex[prev]);
   diag += "\nlimiar=" + DoubleToString(InpThreshold, 2)
         + "  barras=" + IntegerToString(rates_total);
   Comment(diag);

   return rates_total;
}
