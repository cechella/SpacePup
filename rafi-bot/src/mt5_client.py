"""
mt5_client.py — Conexão com MetaTrader 5 (XM)

Abstrai todas as operações com o terminal MT5:
  - Inicialização e autenticação
  - Download de candles históricos
  - Envio e cancelamento de ordens
  - Consulta de posições abertas

ATENÇÃO: Este módulo só funciona em Windows com o MT5 da XM instalado.
Em ambiente de desenvolvimento/backtest, use dados CSV locais.
"""

import logging
import pandas as pd
from datetime import datetime
from typing import Optional

logger = logging.getLogger(__name__)

# Tentativa de importar MetaTrader5 (disponível apenas no Windows)
try:
    import MetaTrader5 as mt5
    MT5_DISPONIVEL = True
except ImportError:
    mt5 = None  # type: ignore
    MT5_DISPONIVEL = False
    logger.warning("MetaTrader5 não disponível. Modo simulação ativado.")


class ClienteMT5:
    """
    Interface com o terminal MetaTrader 5.

    Em ambiente sem MT5 instalado (Linux/desenvolvimento),
    os métodos retornam dados sintéticos ou None, permitindo
    que o backtest e os testes unitários funcionem normalmente.
    """

    def __init__(self, config: dict):
        self.par        = config.get('par', 'EURUSD')
        self.conectado  = False
        self._config    = config

    # ─────────────────────────────────────────────────────────
    # CONEXÃO
    # ─────────────────────────────────────────────────────────

    def conectar(self,
                  login: Optional[int] = None,
                  senha: Optional[str] = None,
                  servidor: Optional[str] = None) -> bool:
        """
        Inicializa e autentica no terminal MT5.

        Parâmetros são opcionais — se omitidos, usa as credenciais
        já configuradas no terminal MT5 aberto.
        """
        if not MT5_DISPONIVEL:
            logger.warning("MT5 não disponível — simulação ativa")
            return False

        if not mt5.initialize():
            logger.error(f"Falha ao inicializar MT5: {mt5.last_error()}")
            return False

        if login and senha and servidor:
            ok = mt5.login(login, password=senha, server=servidor)
            if not ok:
                logger.error(f"Falha no login MT5: {mt5.last_error()}")
                mt5.shutdown()
                return False

        info = mt5.account_info()
        if info is None:
            logger.error("Não foi possível obter informações da conta")
            return False

        logger.info(
            f"MT5 conectado | Conta: {info.login} | Servidor: {info.server} | "
            f"Saldo: ${info.balance:.2f} | Alavancagem: 1:{info.leverage}"
        )
        self.conectado = True
        return True

    def desconectar(self) -> None:
        """Fecha a conexão com o MT5."""
        if MT5_DISPONIVEL and self.conectado:
            mt5.shutdown()
            self.conectado = False
            logger.info("MT5 desconectado")

    # ─────────────────────────────────────────────────────────
    # DADOS DE MERCADO
    # ─────────────────────────────────────────────────────────

    _TF_MAP = {
        'M1' : 1,    # mt5.TIMEFRAME_M1
        'M5' : 5,    # mt5.TIMEFRAME_M5
        'M15': 15,
        'M30': 30,
        'H1' : 16385,
        'H4' : 16388,
        'D1' : 16408,
    }

    def obter_candles(self,
                       timeframe: str = 'M5',
                       n_candles: int = 500,
                       data_inicio: Optional[datetime] = None,
                       data_fim: Optional[datetime] = None) -> Optional[pd.DataFrame]:
        """
        Retorna DataFrame com candles OHLCV para o par configurado.

        Colunas: [open, high, low, close, volume, time]
        Index: datetime UTC

        Parâmetros:
          timeframe  : 'M5', 'M15', 'H1', etc.
          n_candles  : número de candles a partir do mais recente
          data_inicio: se fornecido com data_fim, retorna intervalo
          data_fim   : fim do intervalo (inclusive)
        """
        if not MT5_DISPONIVEL or not self.conectado:
            logger.warning("MT5 indisponível — retornando None")
            return None

        tf_id = self._TF_MAP.get(timeframe.upper())
        if tf_id is None:
            logger.error(f"Timeframe inválido: {timeframe}")
            return None

        if data_inicio and data_fim:
            rates = mt5.copy_rates_range(self.par, tf_id, data_inicio, data_fim)
        else:
            rates = mt5.copy_rates_from_pos(self.par, tf_id, 0, n_candles)

        if rates is None or len(rates) == 0:
            logger.error(f"Sem dados MT5 para {self.par} {timeframe}: {mt5.last_error()}")
            return None

        df = pd.DataFrame(rates)
        df['time'] = pd.to_datetime(df['time'], unit='s', utc=True)
        df = df.set_index('time')
        df = df.rename(columns={
            'open': 'open', 'high': 'high', 'low': 'low',
            'close': 'close', 'tick_volume': 'volume'
        })
        # Manter apenas as colunas necessárias
        df = df[['open', 'high', 'low', 'close', 'volume']]
        return df

    def capital_atual(self) -> float:
        """Retorna o saldo atual da conta em USD."""
        if not MT5_DISPONIVEL or not self.conectado:
            return 0.0
        info = mt5.account_info()
        return float(info.balance) if info else 0.0

    # ─────────────────────────────────────────────────────────
    # ORDENS
    # ─────────────────────────────────────────────────────────

    def enviar_ordem(self,
                      sinal: str,
                      lote: float,
                      stop_loss: float,
                      take_profit: float,
                      comentario: str = "RAFI-Bot") -> Optional[dict]:
        """
        Envia uma ordem a mercado para o par configurado.

        NUNCA envia sem stop-loss — se stop_loss == 0, rejeita.

        Parâmetros:
          sinal      : 'compra' ou 'venda'
          lote       : tamanho do lote (ex.: 0.01)
          stop_loss  : preço do stop
          take_profit: preço do take-profit

        Retorna dict com 'ticket', 'preco_entrada', 'sucesso' ou None em erro.
        """
        if not MT5_DISPONIVEL or not self.conectado:
            logger.warning("Ordem não enviada — MT5 indisponível")
            return None

        # Validação crítica: NUNCA operar sem stop-loss
        if stop_loss == 0 or stop_loss is None:
            logger.error("ORDEM REJEITADA: stop-loss não definido")
            return None

        tipo = mt5.ORDER_TYPE_BUY if sinal == 'compra' else mt5.ORDER_TYPE_SELL
        preco = mt5.symbol_info_tick(self.par)
        if preco is None:
            logger.error(f"Não foi possível obter preço para {self.par}")
            return None

        preco_atual = preco.ask if sinal == 'compra' else preco.bid
        ponto = mt5.symbol_info(self.par).point

        request = {
            "action"      : mt5.TRADE_ACTION_DEAL,
            "symbol"      : self.par,
            "volume"      : lote,
            "type"        : tipo,
            "price"       : preco_atual,
            "sl"          : stop_loss,
            "tp"          : take_profit,
            "deviation"   : 20,           # desvio máximo de preço em pontos
            "magic"       : 20250101,     # número mágico do bot
            "comment"     : comentario,
            "type_time"   : mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }

        resultado = mt5.order_send(request)
        if resultado is None or resultado.retcode != mt5.TRADE_RETCODE_DONE:
            codigo = resultado.retcode if resultado else 'None'
            logger.error(f"Falha ao enviar ordem: retcode={codigo}")
            return None

        logger.info(
            f"Ordem enviada: {sinal.upper()} {lote} {self.par} "
            f"@ {resultado.price:.5f} | SL: {stop_loss:.5f} | TP: {take_profit:.5f} "
            f"| Ticket: {resultado.order}"
        )
        return {
            'ticket'       : resultado.order,
            'preco_entrada': resultado.price,
            'sucesso'      : True,
        }

    def fechar_posicao(self, ticket: int) -> bool:
        """
        Fecha uma posição aberta pelo número do ticket.

        Retorna True se fechada com sucesso.
        """
        if not MT5_DISPONIVEL or not self.conectado:
            return False

        posicao = mt5.positions_get(ticket=ticket)
        if not posicao:
            logger.warning(f"Posição {ticket} não encontrada")
            return False

        pos = posicao[0]
        # Tipo inverso para fechar
        tipo_fechamento = (
            mt5.ORDER_TYPE_SELL if pos.type == mt5.ORDER_TYPE_BUY
            else mt5.ORDER_TYPE_BUY
        )
        preco_tick = mt5.symbol_info_tick(self.par)
        preco = (
            preco_tick.bid if pos.type == mt5.ORDER_TYPE_BUY
            else preco_tick.ask
        )

        request = {
            "action"  : mt5.TRADE_ACTION_DEAL,
            "symbol"  : self.par,
            "volume"  : pos.volume,
            "type"    : tipo_fechamento,
            "position": ticket,
            "price"   : preco,
            "deviation": 20,
            "magic"   : 20250101,
            "comment" : "RAFI-Bot fechamento",
            "type_filling": mt5.ORDER_FILLING_IOC,
        }

        resultado = mt5.order_send(request)
        if resultado is None or resultado.retcode != mt5.TRADE_RETCODE_DONE:
            logger.error(f"Falha ao fechar posição {ticket}: {resultado}")
            return False

        lucro = pos.profit
        logger.info(f"Posição {ticket} fechada | Resultado: ${lucro:.2f}")
        return True

    def posicoes_abertas(self) -> list:
        """Retorna lista de dicts com as posições abertas no par."""
        if not MT5_DISPONIVEL or not self.conectado:
            return []

        posicoes = mt5.positions_get(symbol=self.par)
        if posicoes is None:
            return []

        resultado = []
        for p in posicoes:
            resultado.append({
                'ticket'       : p.ticket,
                'sinal'        : 'compra' if p.type == 0 else 'venda',
                'lote'         : p.volume,
                'preco_entrada': p.price_open,
                'stop_loss'    : p.sl,
                'take_profit'  : p.tp,
                'lucro_atual'  : p.profit,
            })
        return resultado
