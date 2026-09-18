//+------------------------------------------------------------------+
//| RAFI_ColorCandle.mq5  — v3                                       |
//| Branco=neutro | Verde=RAFI>=2.50+alta | Verm=RAFI>=2.50+baixa   |
//| Amarelo=exaustão (anterior forte, atual inverte direção)          |
//+------------------------------------------------------------------+
#property copyright "RAFI Bot"
#property version   "3.00"
#property indicator_chart_window
#property indicator_buffers 5
#property indicator_plots   1

#property indicator_label1 "Open;High;Low;Close"
#property indicator_type1  DRAW_CANDLES
#property indicator_color1 clrWhite, clrLime, clrRed, clrYellow
#property indicator_style1 STYLE_SOLID
#property indicator_width1 1

input int    InpPeriodoATR  = 14;
input int    InpPeriodoVol  = 14;
input int    InpPeriodoMom  = 3;
input double InpLimiar      = 2.50;
input double InpFatorEscala = 1.10;

double BufO[], BufH[], BufL[], BufC[], BufCor[];
int    hATR;

int OnInit()
{
   SetIndexBuffer(0, BufO,   INDICATOR_DATA);
   SetIndexBuffer(1, BufH,   INDICATOR_DATA);
   SetIndexBuffer(2, BufL,   INDICATOR_DATA);
   SetIndexBuffer(3, BufC,   INDICATOR_DATA);
   SetIndexBuffer(4, BufCor, INDICATOR_COLOR_INDEX);

   PlotIndexSetDouble(0, PLOT_EMPTY_VALUE, 0.0);

   ArraySetAsSeries(BufO,   true);
   ArraySetAsSeries(BufH,   true);
   ArraySetAsSeries(BufL,   true);
   ArraySetAsSeries(BufC,   true);
   ArraySetAsSeries(BufCor, true);

   hATR = iATR(_Symbol, _Period, InpPeriodoATR);
   if (hATR == INVALID_HANDLE) { Print("Erro ATR"); return INIT_FAILED; }

   IndicatorSetString(INDICATOR_SHORTNAME, "RAFI Candles");
   return INIT_SUCCEEDED;
}

double Rafi(int i, int total, const double &atr[],
            const double &h[], const double &l[],
            const double &c[], const long &tv[])
{
   int lim = InpPeriodoVol + InpPeriodoMom + 5;
   if (i + lim >= total) return 0.0;
   double atr_v = atr[i+1];
   if (atr_v < _Point) return 0.0;

   double mom = (c[i] - c[i+InpPeriodoMom]) / atr_v;

   double amp = h[i]-l[i], am = 0.0;
   for (int k=i+1;k<=i+InpPeriodoVol;k++) am += h[k]-l[k];
   am /= InpPeriodoVol;
   double amp_r = (am > _Point) ? (amp/am)-1.0 : 0.0;

   double vm = 0.0;
   for (int k=i+1;k<=i+InpPeriodoVol;k++) vm += (double)tv[k];
   vm /= InpPeriodoVol;
   double vol_r = (vm > 0) ? ((double)tv[i]/vm)-1.0 : 0.0;

   return ((mom*1.0)+(amp_r*0.5)+(vol_r*0.3)) / InpFatorEscala;
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
   int minimo = InpPeriodoATR + InpPeriodoVol + InpPeriodoMom + 10;
   if (rates_total < minimo) return 0;

   double atr_buf[];
   ArraySetAsSeries(atr_buf, true);
   if (CopyBuffer(hATR, 0, 0, rates_total, atr_buf) <= 0) return prev_calculated;

   ArraySetAsSeries(open,  true);
   ArraySetAsSeries(high,  true);
   ArraySetAsSeries(low,   true);
   ArraySetAsSeries(close, true);
   ArraySetAsSeries(tick_volume, true);

   int inicio = (prev_calculated <= 0) ? rates_total-1 : prev_calculated-1;

   for (int i = inicio; i >= 0; i--)
   {
      BufO[i] = open[i];
      BufH[i] = high[i];
      BufL[i] = low[i];
      BufC[i] = close[i];
      BufCor[i] = 0; // branco (neutro)

      double r  = Rafi(i,   rates_total, atr_buf, high, low, close, tick_volume);
      double rp = Rafi(i+1, rates_total, atr_buf, high, low, close, tick_volume);

      bool forte_atual = (MathAbs(r)  >= InpLimiar);
      bool forte_prev  = (MathAbs(rp) >= InpLimiar);
      bool alta_atual  = (close[i]   > open[i]);
      bool alta_prev   = (close[i+1] > open[i+1]);

      // Amarelo: candle anterior forte + atual reverte direção
      if (forte_prev && forte_atual && (alta_prev != alta_atual))
         BufCor[i] = 3;
      else if (forte_atual && alta_atual)
         BufCor[i] = 1; // verde
      else if (forte_atual && !alta_atual)
         BufCor[i] = 2; // vermelho
   }
   return rates_total;
}

void OnDeinit(const int reason)
{
   if (hATR != INVALID_HANDLE) IndicatorRelease(hATR);
}
