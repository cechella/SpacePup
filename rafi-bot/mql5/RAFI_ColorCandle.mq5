//+------------------------------------------------------------------+
//| RAFI_ColorCandle.mq5                                             |
//| Pinta candles conforme o índice de força RAFI                    |
//| Fórmula IDÊNTICA ao RAFI_Histograma (mom*25 + amp*3)            |
//|                                                                  |
//|  BRANCO  — neutro  (mag < limiar)                               |
//|  VERDE   — mag >= limiar + candle de alta                       |
//|  VERMELHO — mag >= limiar + candle de baixa                     |
//|  AMARELO — exaustão (barra anterior forte, atual < 40% limiar)  |
//+------------------------------------------------------------------+
#property copyright   "RAFI Bot"
#property version     "2.03"
#property indicator_chart_window
#property indicator_buffers 5
#property indicator_plots   1

#property indicator_label1  "Open;High;Low;Close"
#property indicator_type1   DRAW_CANDLES
#property indicator_color1  clrWhite, clrLime, clrRed, clrYellow
#property indicator_style1  STYLE_SOLID
#property indicator_width1  1

input int    InpPeriodoATR  = 14;   // Período ATR (Wilder)
input int    InpPeriodoMom  = 3;    // Janela de momentum (candles atrás)
input double InpLimiar      = 2.50; // Mesmo limiar do histograma

double BufOpen[];
double BufHigh[];
double BufLow[];
double BufClose[];
double BufColor[];   // 0=branco, 1=verde, 2=vermelho, 3=amarelo

int hATR;

// Cores originais do gráfico — restauradas no OnDeinit
color g_Bull, g_Bear, g_Up, g_Down;

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
   if (hATR == INVALID_HANDLE) { Print("Erro iATR"); return INIT_FAILED; }

   // Esconde candles originais do gráfico para que as cores do indicador
   // (branco, verde, vermelho, amarelo) fiquem visíveis sem serem cobertas
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

   IndicatorSetString(INDICATOR_SHORTNAME, "RAFI Candles");
   return INIT_SUCCEEDED;
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
// Calcula magnitude RAFI — fórmula idêntica ao RAFI_Histograma:
//   mom  = |close[i] - close[i+period]| / close[i+period] * 100
//   amp  = |close[i] - open[i]| / ATR[i]
//   mag  = min(5, mom * 25 + amp * 3)
// Usa ArraySetAsSeries=true → índice 0 = barra atual, índice+N = N barras atrás
double CalcMag(const int i, const int total,
               const double &atr_buf[],
               const double &open[],
               const double &close[],
               const int period)
{
   int prev = i + period;
   if (prev >= total)          return 0.0;
   if (close[prev]  == 0.0)   return 0.0;
   if (atr_buf[i]   < _Point) return 0.0;

   double mom = MathAbs(close[i] - close[prev]) / close[prev] * 100.0;
   double amp = MathAbs(close[i] - open[i]) / atr_buf[i];
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
   int minimo = InpPeriodoATR + InpPeriodoMom + 5;
   if (rates_total < minimo) return 0;

   double atr_buf[];
   ArraySetAsSeries(atr_buf, true);
   if (CopyBuffer(hATR, 0, 0, rates_total, atr_buf) <= 0) return prev_calculated;

   ArraySetAsSeries(open,    true);
   ArraySetAsSeries(high,    true);
   ArraySetAsSeries(low,     true);
   ArraySetAsSeries(close,   true);
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

      double mag  = CalcMag(i,   rates_total, atr_buf, open, close, InpPeriodoMom);
      double magP = CalcMag(i+1, rates_total, atr_buf, open, close, InpPeriodoMom);
      bool   bull = (close[i] > open[i]);

      // Exaustão: barra anterior forte, atual caiu para menos de 40% do limiar
      bool exaustao = (magP >= InpLimiar) && (mag < InpLimiar * 0.4);

      if (exaustao)
         BufColor[i] = 3;              // amarelo
      else if (mag >= InpLimiar && bull)
         BufColor[i] = 1;              // verde — alta forte
      else if (mag >= InpLimiar && !bull)
         BufColor[i] = 2;              // vermelho — baixa forte
      else
         BufColor[i] = 0;              // branco — neutro
   }

   // Diagnóstico: confirma alinhamento com o histograma
   double m0 = CalcMag(0, rates_total, atr_buf, open, close, InpPeriodoMom);
   double m1 = CalcMag(1, rates_total, atr_buf, open, close, InpPeriodoMom);
   string c0 = ((int)BufColor[0]==1) ? "VERDE" :
               ((int)BufColor[0]==2) ? "VERM"  :
               ((int)BufColor[0]==3) ? "AMAR"  : "BRNC";
   Comment("RAFI v2.03 | mag=" + DoubleToString(m0,2) + " [" + c0 + "]"
         + "  prev=" + DoubleToString(m1,2)
         + "  limiar=" + DoubleToString(InpLimiar,1));

   return rates_total;
}
//+------------------------------------------------------------------+
