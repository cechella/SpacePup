//+------------------------------------------------------------------+
//| RAFI_ColorCandle.mq5                                             |
//| v5.00 — DRAW_COLOR_CANDLES (tipo oficial MQL5 para candles       |
//|          multicoloridos, mesmo tipo do Heiken Ashi embutido).    |
//|                                                                  |
//|  #d1d5db  cinza   — consolidação (RAFI < 2.5)                   |
//|  #22c55e  verde   — RAFI ≥ 2.5 + alta                          |
//|  #ef4444  vermelho — RAFI ≥ 2.5 + baixa                        |
//|  #f59e0b  âmbar   — exaustão (mag anterior ≥ 2.5, atual < 1.0) |
//+------------------------------------------------------------------+
#property copyright   "RAFI Bot"
#property version     "5.00"
#property indicator_chart_window
#property indicator_buffers 5
#property indicator_plots   1

#property indicator_label1  "Open;High;Low;Close"
#property indicator_type1   DRAW_COLOR_CANDLES   // tipo correto: candles coloridos individuais
//   0 = #D1D5DB cinza    1 = #22C55E verde
//   2 = #EF4444 vermelho  3 = #F59E0B âmbar
#property indicator_color1  C'209,213,219', C'34,197,94', C'239,68,68', C'245,158,11'
#property indicator_style1  STYLE_SOLID
#property indicator_width1  1

input int    InpPeriodoATR  = 14;   // Período ATR (Wilder)
input int    InpPeriodoMom  = 3;    // Janela de momentum (barras atrás)
input double InpLimiar      = 2.50; // Limiar de força forte

double BufOpen[];
double BufHigh[];
double BufLow[];
double BufClose[];
double BufColor[];   // 0=cinza  1=verde  2=vermelho  3=âmbar

int    hATR;
color  g_Bull, g_Bear, g_Up, g_Down;

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
   if (hATR == INVALID_HANDLE) { Print("iATR falhou"); return INIT_FAILED; }

   // Esconde os candles originais para o indicador ficar visível
   g_Bull = (color)ChartGetInteger(0, CHART_COLOR_CANDLE_BULL);
   g_Bear = (color)ChartGetInteger(0, CHART_COLOR_CANDLE_BEAR);
   g_Up   = (color)ChartGetInteger(0, CHART_COLOR_CHART_UP);
   g_Down = (color)ChartGetInteger(0, CHART_COLOR_CHART_DOWN);
   AplicarFundoCandlesOriginais();

   IndicatorSetString(INDICATOR_SHORTNAME, "RAFI Candles v5");
   return INIT_SUCCEEDED;
}

// Torna os candles originais invisíveis (mesma cor do fundo)
void AplicarFundoCandlesOriginais()
{
   color bg = (color)ChartGetInteger(0, CHART_COLOR_BACKGROUND);
   ChartSetInteger(0, CHART_COLOR_CANDLE_BULL, bg);
   ChartSetInteger(0, CHART_COLOR_CANDLE_BEAR, bg);
   ChartSetInteger(0, CHART_COLOR_CHART_UP,    bg);
   ChartSetInteger(0, CHART_COLOR_CHART_DOWN,  bg);
   ChartRedraw(0);
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   ChartSetInteger(0, CHART_COLOR_CANDLE_BULL, g_Bull);
   ChartSetInteger(0, CHART_COLOR_CANDLE_BEAR, g_Bear);
   ChartSetInteger(0, CHART_COLOR_CHART_UP,    g_Up);
   ChartSetInteger(0, CHART_COLOR_CHART_DOWN,  g_Down);
   if (hATR != INVALID_HANDLE) IndicatorRelease(hATR);
   ChartRedraw(0);
   Comment("");
}

//+------------------------------------------------------------------+
// Replica calcRAFI() de lib/indicators.ts (magnitude, sempre ≥ 0).
// Fórmula:
//   mom = |close[i] - close[i+period]| / close[i+period] * 100
//   amp = |close[i] - open[i]| / ATR[i]
//   mag = min(5, mom*25 + amp*3)
// Indexação AS_SERIES: i=0 = barra atual; i+N = N barras atrás.
double Magnitude(const int i, const int total,
                 const double &atr[],
                 const double &op[], const double &cl[],
                 const int period)
{
   int prev = i + period;
   if (prev >= total)     return 0.0;
   if (cl[prev] == 0.0)  return 0.0;
   if (atr[i] < _Point)  return 0.0;

   double mom = MathAbs(cl[i] - cl[prev]) / cl[prev] * 100.0;
   double amp = MathAbs(cl[i] - op[i]) / atr[i];
   return MathMin(5.0, mom * 25.0 + amp * 3.0);
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
   if (rates_total < InpPeriodoATR + InpPeriodoMom + 5) return 0;

   // Re-aplica ocultação a cada cálculo completo (garante que reset externo não desfaça)
   if (prev_calculated == 0) AplicarFundoCandlesOriginais();

   double atr[];
   ArraySetAsSeries(atr, true);
   if (CopyBuffer(hATR, 0, 0, rates_total, atr) <= 0) return prev_calculated;

   ArraySetAsSeries(open,     true);
   ArraySetAsSeries(high,     true);
   ArraySetAsSeries(low,      true);
   ArraySetAsSeries(close,    true);
   ArraySetAsSeries(BufOpen,  true);
   ArraySetAsSeries(BufHigh,  true);
   ArraySetAsSeries(BufLow,   true);
   ArraySetAsSeries(BufClose, true);
   ArraySetAsSeries(BufColor, true);

   int inicio = (prev_calculated <= 0) ? rates_total - 1 : prev_calculated - 1;

   for (int i = inicio; i >= 0; i--)
   {
      BufOpen[i]  = open[i];
      BufHigh[i]  = high[i];
      BufLow[i]   = low[i];
      BufClose[i] = close[i];

      double mag  = Magnitude(i,   rates_total, atr, open, close, InpPeriodoMom);
      double magP = Magnitude(i+1, rates_total, atr, open, close, InpPeriodoMom);
      bool   bull = (close[i] > open[i]);

      // Replica applyRAFICandleColors() de lib/indicators.ts
      bool exaustao = (magP >= InpLimiar) && (mag < 1.0);

      if (exaustao)
         BufColor[i] = 3;            // âmbar — exaustão
      else if (mag >= InpLimiar && bull)
         BufColor[i] = 1;            // verde — alta forte
      else if (mag >= InpLimiar && !bull)
         BufColor[i] = 2;            // vermelho — baixa forte
      else
         BufColor[i] = 0;            // cinza — consolidação
   }

   double m0 = Magnitude(0, rates_total, atr, open, close, InpPeriodoMom);
   double m1 = Magnitude(1, rates_total, atr, open, close, InpPeriodoMom);
   string c0 = ((int)BufColor[0]==1)?"VERDE":((int)BufColor[0]==2)?"VERM":((int)BufColor[0]==3)?"AMBAR":"CINZA";
   Comment("RAFI v5.00 | mag=" + DoubleToString(m0,2) + " [" + c0 + "]  prev=" + DoubleToString(m1,2));

   return rates_total;
}
//+------------------------------------------------------------------+
