//+------------------------------------------------------------------+
//| RAFI_ColorCandle.mq5  — v1.05 DIAGNÓSTICO SIMPLES               |
//| SEM mudar modo do gráfico. TODAS as barras VERMELHAS.            |
//+------------------------------------------------------------------+
#property copyright   "RAFI Bot"
#property version     "1.05"
#property description "DIAGNOSTICO SIMPLES"

#property indicator_chart_window
#property indicator_buffers 5
#property indicator_plots   1

#property indicator_label1  "RAFI Candle"
#property indicator_type1   DRAW_COLOR_CANDLES
#property indicator_style1  STYLE_SOLID
#property indicator_width1  1

#property indicator_color1  clrGray
#property indicator_color2  clrLimeGreen
#property indicator_color3  clrRed
#property indicator_color4  clrYellow

double CandleOpen[];
double CandleHigh[];
double CandleLow[];
double CandleClose[];
double ColorIndex[];

int OnInit()
{
   SetIndexBuffer(0, CandleOpen,  INDICATOR_DATA);
   SetIndexBuffer(1, CandleHigh,  INDICATOR_DATA);
   SetIndexBuffer(2, CandleLow,   INDICATOR_DATA);
   SetIndexBuffer(3, CandleClose, INDICATOR_DATA);
   SetIndexBuffer(4, ColorIndex,  INDICATOR_COLOR_INDEX);
   PlotIndexSetDouble(0, PLOT_EMPTY_VALUE, 0.0);
   IndicatorSetString(INDICATOR_SHORTNAME, "RAFI v1.05 TEST");
   Comment("RAFI v1.05 RODANDO");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) { Comment(""); }

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
   for(int i = 1; i < rates_total; i++)
   {
      CandleOpen[i]  = open[i];
      CandleHigh[i]  = high[i];
      CandleLow[i]   = low[i];
      CandleClose[i] = close[i];
      ColorIndex[i]  = 2; // 2 = clrRed
   }
   Comment("RAFI v1.05 — barras: " + IntegerToString(rates_total));
   return rates_total;
}
