"""
scripts/export_para_dashboard.py — Exporta trades do backtest para o dashboard

Converte os trades gerados pelo backtest em JSON compatível com o localStorage
do dashboard RAFI (chave: 'rafi-trade-log').

Uso com CSV real (M5 exportado do MT5):
  python scripts/export_para_dashboard.py \\
    --m5 data/EURUSD_M5.csv \\
    --saida data/rafi-trade-log.json \\
    --capital 100

Modo sintético (para testar o formato sem CSV):
  python scripts/export_para_dashboard.py --sintetico

Após gerar o JSON:
  1. Abra https://space-pup.vercel.app/admin
  2. Clique em "Importar Backtest" (botão na barra superior)
  3. Selecione o arquivo gerado
  4. Todos os trades aparecem automaticamente no dashboard

Formato MT5 esperado (exportar via Data > Export > CSV):
  Colunas obrigatórias (separadas por tab): Date  Time  Open  High  Low  Close  Volume
  O script detecta automaticamente formatos com ou sem coluna de volume.
"""

import argparse
import json
import logging
import os
import sys
import uuid
import yaml
from datetime import timezone

# Adiciona raiz do projeto ao path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backtest.engine import Backtest, BacktestCSV
from run_backtest import gerar_dados_sinteticos, reamostrar


# ─────────────────────────────────────────────────────────────────────────────
# TABELA AGRESSIVA DE LOTES (espelho exato do dashboard — SCALE_TIERS)
# Capital mínimo → lote padrão. Dobra conforme capital cresce.
# ─────────────────────────────────────────────────────────────────────────────
SCALE_TIERS_PYTHON: list[tuple[float, float]] = [
    (0,        0.20),
    (150,      0.40),
    (200,      0.80),
    (300,      1.00),
    (600,      2.00),
    (1_200,    4.00),
    (2_500,    8.00),
    (5_000,   15.00),
    (10_000,  30.00),
    (25_000,  60.00),
    (50_000, 120.00),
    (100_000, 250.00),
    (200_000, 500.00),
]


def lote_agressivo(capital: float) -> float:
    """Retorna o lote da tabela agressiva do dashboard pelo capital atual."""
    lote = SCALE_TIERS_PYTHON[0][1]
    for min_cap, lot in SCALE_TIERS_PYTHON:
        if capital >= min_cap:
            lote = lot
    return lote


# ─────────────────────────────────────────────────────────────────────────────
# CONVERSÃO BACKTEST → FORMATO ManualTrade DO DASHBOARD
# ─────────────────────────────────────────────────────────────────────────────

def _resultado(trade: dict) -> str:
    """
    Determina win/loss pelo motivo de saída e P&L.
    Prioridade: motivo_saida > pnl_usd.
    """
    motivo = trade.get('motivo_saida', '')
    pnl    = float(trade.get('pnl_usd', 0))

    if 'Take profit' in motivo or 'take profit' in motivo.lower():
        return 'win'
    if 'Stop loss' in motivo or 'stop loss' in motivo.lower():
        return 'loss'
    # Saídas neutras (exaustão, fim do período): usa P&L
    return 'win' if pnl > 0 else 'loss'


def trade_para_dashboard(trade: dict, capital_entrada: float) -> dict:
    """
    Converte um dict de trade do backtest no formato ManualTrade do dashboard.

    O lote é recalculado pela tabela agressiva baseado no capital NO MOMENTO
    da entrada — o mesmo lote que o bot usaria se aplicasse esta estratégia.
    """
    sinal     = trade['sinal']
    direction = 'buy' if sinal == 'compra' else 'sell'
    result    = _resultado(trade)

    # Timestamp Unix em segundos (campo 'time' do ManualTrade)
    ts = trade['timestamp_entrada']
    if hasattr(ts, 'timestamp'):
        time_unix = int(ts.timestamp())
    elif hasattr(ts, 'value'):
        # numpy datetime64 → segundos
        time_unix = int(ts.value // 1_000_000_000)
    else:
        time_unix = 0

    # Label legível para o dashboard
    ts_str = ts.strftime('%Y-%m-%d %H:%M') if hasattr(ts, 'strftime') else str(ts)[:16]
    label  = f"{'BUY' if direction == 'buy' else 'SELL'} {ts_str}"

    # Lote: usa a tabela agressiva pelo capital no momento da entrada
    lot = lote_agressivo(capital_entrada)

    # Força RAFI (pode ser NaN para estratégias que não o calculam)
    forca_raw = trade.get('forca_entrada')
    rafi_val  = round(float(forca_raw), 3) if forca_raw is not None and forca_raw == forca_raw else 0.0

    return {
        'id'        : str(uuid.uuid4()),
        'direction' : direction,
        'entry'     : round(float(trade['preco_entrada']), 5),
        'stopLoss'  : round(float(trade['stop_loss']),     5),
        'takeProfit': round(float(trade['take_profit']),   5),
        'label'     : label,
        'time'      : time_unix,
        'lot'       : lot,
        'leverage'  : 1000,
        'result'    : result,
        'rafi'      : rafi_val,
        'rafiDir'   : 'bull' if direction == 'buy' else 'bear',
    }


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description='Backtest RAFI → JSON compatível com o dashboard'
    )
    parser.add_argument('--m5',       default=None,
                        help='CSV M5 exportado do MT5 (obrigatório para dados reais)')
    parser.add_argument('--config',   default='config.yaml',
                        help='Arquivo de configuração YAML (padrão: config.yaml)')
    parser.add_argument('--saida',    default='data/rafi-trade-log.json',
                        help='Arquivo JSON de saída (padrão: data/rafi-trade-log.json)')
    parser.add_argument('--capital',  type=float, default=100.0,
                        help='Capital inicial em USD (padrão: 100)')
    parser.add_argument('--sintetico', action='store_true',
                        help='Usar dados sintéticos (apenas teste do formato)')
    parser.add_argument('--modo',     default=None,
                        help='Sobrescreve estrategia_modo do config.yaml (ex: rafi, rsi_rev)')
    parser.add_argument('--log',      default='INFO',
                        help='Nível de log: DEBUG, INFO, WARNING (padrão: INFO)')
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log.upper(), logging.INFO),
        format='%(asctime)s | %(levelname)-8s | %(message)s',
        handlers=[logging.StreamHandler(sys.stdout)],
    )
    logger = logging.getLogger(__name__)

    # ── Carregar config ────────────────────────────────────────────────────
    config_path = args.config
    if not os.path.exists(config_path):
        # Tenta encontrar no diretório pai (caso executado de dentro de scripts/)
        config_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'config.yaml')
    if not os.path.exists(config_path):
        logger.error(f"config.yaml não encontrado em {args.config} nem no diretório raiz")
        sys.exit(1)

    with open(config_path, 'r', encoding='utf-8') as f:
        config = yaml.safe_load(f)

    # Sobrescreve modo de estratégia se especificado via CLI
    if args.modo:
        config['estrategia_modo'] = args.modo
        logger.info(f"Modo de estratégia sobrescrito: {args.modo}")

    capital = args.capital if args.capital is not None else float(config.get('capital_inicial', 100.0))

    # ── Carregar dados ─────────────────────────────────────────────────────
    if args.sintetico or not args.m5:
        if not args.sintetico:
            logger.warning("Arquivo CSV não fornecido. Usando dados SINTÉTICOS.")
            logger.warning("Para resultados reais: use --m5 data/EURUSD_M5.csv")
        else:
            logger.info("Modo sintético — gerando 8640 candles (~30 dias)")
        df_m5  = gerar_dados_sinteticos(n_candles=8640, tf_minutos=5)
        df_m15 = reamostrar(df_m5, 15)
        bt = Backtest(config, df_m5, df_m15, capital=capital)
    else:
        if not os.path.exists(args.m5):
            logger.error(f"Arquivo CSV não encontrado: {args.m5}")
            sys.exit(1)
        logger.info(f"Carregando CSV: {args.m5}")
        bt = BacktestCSV.de_csv(config, args.m5, args.m5, capital=capital)

    # ── Executar backtest ──────────────────────────────────────────────────
    logger.info(f"Executando backtest | Estratégia: {config.get('estrategia_modo', 'rafi')} | Capital: ${capital:.2f}")
    trades_raw = bt.executar()

    if not trades_raw:
        logger.error("Nenhum trade gerado. Verifique os parâmetros do config.yaml ou o arquivo CSV.")
        logger.error("Dica: ajuste os thresholds (forca_limiar, sessoes) para gerar mais trades.")
        sys.exit(1)

    # ── Converter para formato do dashboard ───────────────────────────────
    logger.info(f"Convertendo {len(trades_raw)} trades para o formato do dashboard...")
    dashboard_trades = []
    capital_atual = capital

    for trade in trades_raw:
        # Capital no momento da entrada (antes de fechar este trade)
        cap_entrada = float(trade.get('capital_entrada', capital_atual))
        dt = trade_para_dashboard(trade, cap_entrada)
        dashboard_trades.append(dt)
        # Atualiza capital para o próximo trade
        capital_atual = float(trade.get('capital_apos', capital_atual))

    # ── Salvar JSON ────────────────────────────────────────────────────────
    saida_dir = os.path.dirname(args.saida)
    if saida_dir:
        os.makedirs(saida_dir, exist_ok=True)

    with open(args.saida, 'w', encoding='utf-8') as f:
        json.dump(dashboard_trades, f, ensure_ascii=False, indent=2)

    # ── Relatório de exportação ────────────────────────────────────────────
    wins   = sum(1 for t in dashboard_trades if t['result'] == 'win')
    losses = sum(1 for t in dashboard_trades if t['result'] == 'loss')
    wr     = wins / (wins + losses) * 100 if (wins + losses) > 0 else 0

    logger.info("─" * 60)
    logger.info(f"EXPORTAÇÃO CONCLUÍDA")
    logger.info(f"  Arquivo : {os.path.abspath(args.saida)}")
    logger.info(f"  Trades  : {len(dashboard_trades)}")
    logger.info(f"  Win rate: {wr:.1f}%  ({wins}W / {losses}L)")
    logger.info(f"  Capital : ${capital:.2f} → ${capital_atual:.2f}")
    logger.info("─" * 60)
    logger.info(f"PRÓXIMOS PASSOS:")
    logger.info(f"  1. Abra https://space-pup.vercel.app/admin")
    logger.info(f"  2. Clique em 'Importar Backtest' (botão no header)")
    logger.info(f"  3. Selecione o arquivo: {os.path.abspath(args.saida)}")
    logger.info(f"  4. Os {len(dashboard_trades)} trades aparecerão automaticamente")
    if len(dashboard_trades) < 300:
        logger.warning(f"  ⚠ Apenas {len(dashboard_trades)} trades — meta é 300+ para treinar o ML")
        logger.warning(f"    Use um CSV com pelo menos 1 ano de dados EURUSD M5")


if __name__ == '__main__':
    main()
