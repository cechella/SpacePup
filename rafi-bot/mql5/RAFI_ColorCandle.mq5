//+------------------------------------------------------------------+
//| RAFI_ColorCandle.mq5                                             |
//| Velas coloridas pelo índice de força RAFI                        |
//| Verde   = RAFI ≥ limiar + candle de alta  (força forte)         |
//| Vermelho = RAFI ≥ limiar + candle de baixa (força forte)        |
//| Amarelo = exaustão (mag anterior ≥ limiar e mag atual < 40%)    |
//| Cinza   = consolidação (RAFI < limiar)                          |
//+------------------------------------------------------------------+
#property copyright   "RAFI Bot"
#property version     "1.02"
#property description "Velas coloridas pelo índice de força RAFI"

#property indicator_chart_window
#property indicator_buffers 7
#property indicator_plots   1

#property indicator_label1  "RAFI Candle"
#property indicator_type1   DRAW_COLOR_CANDLES
#property indicator_style1  STYLE_SOLID
#property indicator_width1  1

// Índice de cor: 0=Cinza | 1=Verde | 2=Vermelho | 3=Amarelo
#property indicator_color1  clrGray         // 0 — consolidação
#property indicator_color2  clrLimeGreen    // 1 — alta forte
#property indicator_color3  clrRed          // 2 — baixa forte
#property indicator_color4  clrYellow       // 3 — exaustão

input int    InpATRPeriod  = 14;  // Período ATR (suavização Wilder)
input int    InpRAFIPeriod =  3;  // Janela de momentum (candles atrás)
input double InpThreshold  = 1.0; // Limiar RAFI (1.0 = moderado; 2.5 = forte)

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

// Cores originais do gráfico (salvas no OnInit para restaurar no OnDeinit)
color g_colorCandleBull;
color g_colorCandleBear;
color g_colorChartUp;
color g_colorChartDown;

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

   // ── Esconde candles originais do gráfico ─────────────────────────
   // O MT5 desenha os candles originais POR CIMA do DRAW_COLOR_CANDLES,
   // ocultando as cores do indicador. Solução: pintar os candles
   // originais com a cor de fundo (invisíveis) durante o indicador ativo.
   g_colorCandleBull = (color)ChartGetInteger(0, CHART_COLOR_CANDLE_BULL);
   g_colorCandleBear = (color)ChartGetInteger(0, CHART_COLOR_CANDLE_BEAR);
   g_colorChartUp    = (color)ChartGetInteger(0, CHART_COLOR_CHART_UP);
   g_colorChartDown  = (color)ChartGetInteger(0, CHART_COLOR_CHART_DOWN);

   color bg = (color)ChartGetInteger(0, CHART_COLOR_BACKGROUND);
   ChartSetInteger(0, CHART_COLOR_CANDLE_BULL, bg);
   ChartSetInteger(0, CHART_COLOR_CANDLE_BEAR, bg);
   ChartSetInteger(0, CHART_COLOR_CHART_UP,    bg);
   ChartSetInteger(0, CHART_COLOR_CHART_DOWN,  bg);

   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnDeinit(const int reason)
{
   // Restaura as cores originais ao remover o indicador
   ChartSetInteger(0, CHART_COLOR_CANDLE_BULL, g_colorCandleBull);
   ChartSetInteger(0, CHART_COLOR_CANDLE_BEAR, g_colorCandleBear);
   ChartSetInteger(0, CHART_COLOR_CHART_UP,    g_colorChartUp);
   ChartSetInteger(0, CHART_COLOR_CHART_DOWN,  g_colorChartDown);
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

   // ── RAFI (magnitude absoluta) ────────────────────────────────────
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

   // ── Copia OHLC e aplica cor — roda em TODAS as barras ────────────
   // Loop não-incremental: garante que mudanças em InpThreshold
   // reflitam imediatamente em todo o histórico visível.
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

      // Exaustão: força forte no anterior, colapso brusco agora
      bool exhaustion = (magPrev >= InpThreshold) && (mag < InpThreshold * 0.4);

      if(exhaustion)
         ColorIndex[i] = 3;                    // amarelo — exaustão
      else if(mag >= InpThreshold)
         ColorIndex[i] = isBull ? 1.0 : 2.0;   // verde (alta) ou vermelho (baixa)
      else
         ColorIndex[i] = 0;                    // cinza — consolidação
   }

   return rates_total;
}
//+------------------------------------------------------------------+
