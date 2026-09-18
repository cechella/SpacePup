//+------------------------------------------------------------------+
//| RAFI_Histograma.mq5  — v3                                        |
//| Histograma dourado. Linhas tracejadas em +2.50 / 0 / -2.50       |
//+------------------------------------------------------------------+
#property copyright "RAFI Bot"
#property version   "3.00"
#property indicator_separate_window
#property indicator_buffers 1
#property indicator_plots   1

#property indicator_label1 "RAFI"
#property indicator_type1  DRAW_HISTOGRAM
#property indicator_color1 clrGoldenrod
#property indicator_style1 STYLE_SOLID
#property indicator_width1 2

input int    InpPeriodoATR  = 14;
input int    InpPeriodoVol  = 14;
input int    InpPeriodoMom  = 3;
input double InpLimiar      = 2.50;
input double InpFatorEscala = 1.10;

double Buf[];
int    hATR;

int OnInit()
{
   SetIndexBuffer(0, Buf, INDICATOR_DATA);
   PlotIndexSetDouble(0, PLOT_EMPTY_VALUE, EMPTY_VALUE);
   ArraySetAsSeries(Buf, true);

   hATR = iATR(_Symbol, _Period, InpPeriodoATR);
   if (hATR == INVALID_HANDLE) { Print("Erro ATR"); return INIT_FAILED; }

   IndicatorSetString(INDICATOR_SHORTNAME, "RAFI");
   IndicatorSetInteger(INDICATOR_DIGITS, 2);

   IndicatorSetInteger(INDICATOR_LEVELS, 3);
   IndicatorSetDouble (INDICATOR_LEVELVALUE, 0,  InpLimiar);
   IndicatorSetDouble (INDICATOR_LEVELVALUE, 1, -InpLimiar);
   IndicatorSetDouble (INDICATOR_LEVELVALUE, 2,  0.0);
   IndicatorSetInteger(INDICATOR_LEVELCOLOR, 0, clrLime);
   IndicatorSetInteger(INDICATOR_LEVELCOLOR, 1, clrRed);
   IndicatorSetInteger(INDICATOR_LEVELCOLOR, 2, clrDimGray);
   IndicatorSetInteger(INDICATOR_LEVELSTYLE, 0, STYLE_DASH);
   IndicatorSetInteger(INDICATOR_LEVELSTYLE, 1, STYLE_DASH);
   IndicatorSetInteger(INDICATOR_LEVELSTYLE, 2, STYLE_DOT);
   IndicatorSetString (INDICATOR_LEVELTEXT,  0, "+2.50");
   IndicatorSetString (INDICATOR_LEVELTEXT,  1, "-2.50");

   return INIT_SUCCEEDED;
}

int OnCalculate(const int rates_total,
                const int prev_calculated,
                const datetime &time[],
                const double   &open[],
                const double   &high[],
                const double   &low[],
                const double   &close[],
                const long     &tick_volume[],
                const long     &volume[],
                const int      &spread[])
{
   int minimo = InpPeriodoATR + InpPeriodoVol + InpPeriodoMom + 5;
   if (rates_total < minimo) return 0;

   double atr_buf[];
   ArraySetAsSeries(atr_buf, true);
   if (CopyBuffer(hATR, 0, 0, rates_total, atr_buf) <= 0) return prev_calculated;

   ArraySetAsSeries(open,  true);
   ArraySetAsSeries(high,  true);
   ArraySetAsSeries(low,   true);
   ArraySetAsSeries(close, true);
   ArraySetAsSeries(tick_volume, true);

   int inicio = (prev_calculated <= 0) ? rates_total - 1 : prev_calculated - 1;
   int limite = InpPeriodoVol + InpPeriodoMom + 5;

   for (int i = inicio; i >= 0; i--)
   {
      Buf[i] = EMPTY_VALUE;
      if (i + limite >= rates_total) continue;

      double atr = atr_buf[i + 1];
      if (atr < _Point) continue;

      double mom = (close[i] - close[i + InpPeriodoMom]) / atr;

      double amp = high[i] - low[i], amp_m = 0.0;
      for (int k = i+1; k <= i+InpPeriodoVol; k++) amp_m += high[k]-low[k];
      amp_m /= InpPeriodoVol;
      double amp_r = (amp_m > _Point) ? (amp/amp_m) - 1.0 : 0.0;

      double vol_m = 0.0;
      for (int k = i+1; k <= i+InpPeriodoVol; k++) vol_m += (double)tick_volume[k];
      vol_m /= InpPeriodoVol;
      double vol_r = (vol_m > 0) ? ((double)tick_volume[i]/vol_m) - 1.0 : 0.0;

      Buf[i] = ((mom * 1.0) + (amp_r * 0.5) + (vol_r * 0.3)) / InpFatorEscala;
   }
   return rates_total;
}

void OnDeinit(const int reason)
{
   if (hATR != INVALID_HANDLE) IndicatorRelease(hATR);
}
