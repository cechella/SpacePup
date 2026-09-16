//+------------------------------------------------------------------+
//| RAFI_ColorCandle.mq5                                             |
//| Pinta candles conforme o índice de força RAFI                    |
//|                                                                  |
//|  BRANCO  — neutro (RAFI entre -2.50 e +2.50)                    |
//|  VERDE   — RAFI >= +2.50 e candle de alta (compra)              |
//|  VERMELHO — RAFI <= -2.50 e candle de baixa (venda)             |
//|  AMARELO — exaustão (candle anterior forte, atual fraco/reverteu)|
//+------------------------------------------------------------------+
#property copyright   "RAFI Bot"
#property version     "2.01"
#property indicator_chart_window
#property indicator_buffers 5
#property indicator_plots   1

// Um único plot DRAW_CANDLES com 4 cores indexadas
#property indicator_label1  "Open;High;Low;Close"
#property indicator_type1   DRAW_CANDLES
#property indicator_color1  clrWhite, clrLime, clrRed, clrYellow
#property indicator_style1  STYLE_SOLID
#property indicator_width1  1

input int    InpPeriodoATR   = 14;
input int    InpPeriodoVol   = 14;
input int    InpPeriodoMom   = 3;
input double InpLimiar       = 2.50;
input double InpFatorEscala  = 1.10;

// 4 buffers OHLC + 1 buffer de índice de cor
double BufOpen[];
double BufHigh[];
double BufLow[];
double BufClose[];
double BufColor[];   // 0=branco, 1=verde, 2=vermelho, 3=amarelo

int hATR;

//+------------------------------------------------------------------+
int OnInit()
{
   SetIndexBuffer(0, BufOpen,  INDICATOR_DATA);
   SetIndexBuffer(1, BufHigh,  INDICATOR_DATA);
   SetIndexBuffer(2, BufLow,   INDICATOR_DATA);
   SetIndexBuffer(3, BufClose, INDICATOR_DATA);
   SetIndexBuffer(4, BufColor, INDICATOR_COLOR_INDEX);

   PlotIndexSetDouble(0, PLOT_EMPTY_VALUE, 0.0);

   hATR = iATR(_Symbol, _Period, InpPeriodoATR);
   if (hATR == INVALID_HANDLE) { Print("Erro ATR"); return INIT_FAILED; }

   IndicatorSetString(INDICATOR_SHORTNAME, "RAFI Candles");
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
double CalcRafi(const int i, const int total,
                const double &atr_buf[],
                const double &high[], const double &low[],
                const double &close[], const long &tick_volume[])
{
   int limite = InpPeriodoVol + InpPeriodoMom + 5;
   if (i + limite >= total) return 0.0;
   double atr = atr_buf[i + 1];
   if (atr < _Point) return 0.0;

   double mom  = (close[i] - close[i + InpPeriodoMom]) / atr;

   double amp = high[i] - low[i], amp_m = 0.0;
   for (int k = i+1; k <= i+InpPeriodoVol; k++) amp_m += high[k]-low[k];
   amp_m /= InpPeriodoVol;
   double amp_r = (amp_m > _Point) ? (amp / amp_m) - 1.0 : 0.0;

   double vol_m = 0.0;
   for (int k = i+1; k <= i+InpPeriodoVol; k++) vol_m += (double)tick_volume[k];
   vol_m /= InpPeriodoVol;
   double vol_r = (vol_m > 0) ? ((double)tick_volume[i] / vol_m) - 1.0 : 0.0;

   return ((mom * 1.0) + (amp_r * 0.5) + (vol_r * 0.3)) / InpFatorEscala;
}

//+------------------------------------------------------------------+
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

   ArraySetAsSeries(open,        true);
   ArraySetAsSeries(high,        true);
   ArraySetAsSeries(low,         true);
   ArraySetAsSeries(close,       true);
   ArraySetAsSeries(tick_volume, true);
   ArraySetAsSeries(BufOpen,     true);
   ArraySetAsSeries(BufHigh,     true);
   ArraySetAsSeries(BufLow,      true);
   ArraySetAsSeries(BufClose,    true);
   ArraySetAsSeries(BufColor,    true);

   int inicio = (prev_calculated <= 0) ? rates_total - 1 : prev_calculated - 1;

   for (int i = inicio; i >= 0; i--)
   {
      BufOpen[i]  = open[i];
      BufHigh[i]  = high[i];
      BufLow[i]   = low[i];
      BufClose[i] = close[i];
      BufColor[i] = 0; // padrão: branco

      double rafi      = CalcRafi(i,   rates_total, atr_buf, high, low, close, tick_volume);
      double rafi_prev = CalcRafi(i+1, rates_total, atr_buf, high, low, close, tick_volume);

      // Exaustão: barra anterior forte (|rafi_prev| >= limiar) e atual caiu para
      // menos de 40% do limiar — sinal de enfraquecimento do movimento
      bool exaustao = (MathAbs(rafi_prev) >= InpLimiar) &&
                      (MathAbs(rafi) < InpLimiar * 0.4);

      if (exaustao)
         BufColor[i] = 3; // amarelo — exaustão
      else if (rafi >= InpLimiar && close[i] > open[i])
         BufColor[i] = 1; // verde — rompimento de resistência
      else if (rafi <= -InpLimiar && close[i] < open[i])
         BufColor[i] = 2; // vermelho — rompimento de suporte
      // else fica 0 = branco (neutro)
   }

   return rates_total;
}

void OnDeinit(const int reason)
{
   if (hATR != INVALID_HANDLE) IndicatorRelease(hATR);
}
//+------------------------------------------------------------------+
