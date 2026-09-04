"""
predictor.py — Filtro ML em produção: decide se um sinal deve virar trade

Fluxo:
  1. Recebe sinal do strategy.py (candles + direção + força)
  2. Extrai as 12 features via feature_builder.py
  3. Carrega modelo XGBoost treinado (modelo.pkl)
  4. Calcula P(win) — se ≥ threshold → OPERA | se < threshold → IGNORA

O modelo é carregado uma vez e fica em memória (singleton). Retreino
automático acontece via train.py quando WR < 70% ou PF < 2.0.
"""

import os
import pickle
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from src.ml.feature_builder import extrair_features, FEATURE_NAMES, N_FEATURES

# ── Caminho padrão do modelo ─────────────────────────────────────────────────
BASE_DIR   = Path(__file__).resolve().parent.parent.parent
MODELO_PKL = BASE_DIR / 'src' / 'ml' / 'modelo.pkl'

# ── Threshold padrão (parametrizável via config.yaml) ────────────────────────
THRESHOLD_PADRAO = 0.65  # P(win) mínimo para operar


class PreditorML:
    """
    Singleton que carrega o modelo XGBoost e filtra sinais em tempo real.

    Uso:
        preditor = PreditorML()
        deve_operar = preditor.filtrar(candles, direcao=1, forca=0.00007, rr=1.3)
    """

    _instancia: Optional['PreditorML'] = None
    _lock = threading.Lock()

    def __init__(
        self,
        caminho_modelo: Optional[Path] = None,
        threshold: float = THRESHOLD_PADRAO,
    ):
        self._caminho = Path(caminho_modelo) if caminho_modelo else MODELO_PKL
        self._threshold = threshold
        self._modelo = None
        self._metadados: dict = {}
        self._lock_modelo = threading.Lock()
        self._carregar_modelo()

    @classmethod
    def obter(cls, threshold: float = THRESHOLD_PADRAO) -> 'PreditorML':
        """Retorna instância singleton (thread-safe)."""
        if cls._instancia is None:
            with cls._lock:
                if cls._instancia is None:
                    cls._instancia = cls(threshold=threshold)
        return cls._instancia

    def _carregar_modelo(self) -> bool:
        """Carrega ou recarrega o modelo do disco. Retorna True se bem-sucedido."""
        if not self._caminho.exists():
            return False

        try:
            with open(self._caminho, 'rb') as f:
                pacote = pickle.load(f)

            with self._lock_modelo:
                self._modelo    = pacote['modelo']
                self._metadados = {
                    'treinado_em':  pacote.get('treinado_em', ''),
                    'n_trades':     pacote.get('n_trades', 0),
                    'wr_historico': pacote.get('wr_historico', 0),
                    'threshold':    pacote.get('threshold', self._threshold),
                    'metricas':     pacote.get('metricas', {}),
                }
                # Usa o threshold salvo no modelo (pode ser diferente do padrão)
                self._threshold = pacote.get('threshold', self._threshold)

            return True

        except Exception as e:
            print(f"[PreditorML] ERRO ao carregar modelo: {e}")
            return False

    def recarregar(self) -> bool:
        """Recarrega o modelo após retreino. Pode ser chamado a quente (thread-safe)."""
        ok = self._carregar_modelo()
        if ok:
            print(f"[PreditorML] Modelo recarregado — treinado em {self._metadados.get('treinado_em', '?')}")
        return ok

    def modelo_disponivel(self) -> bool:
        """Retorna True se o modelo está carregado e pronto para uso."""
        return self._modelo is not None

    def filtrar(
        self,
        candles_ate_sinal: list,
        direcao: int,
        forca_rompimento: float,
        rr_ratio: float,
        wr_rolling20: float = 0.5,
        sr_lookback: int = 15,
        bb_periodo: int = 10,
    ) -> tuple[bool, float]:
        """
        Decide se o sinal deve virar trade.

        Parâmetros:
            candles_ate_sinal : lista de dicts {time, open, high, low, close}
            direcao           : +1 (compra) ou -1 (venda)
            forca_rompimento  : distância do close ao S/R em preço (ex: 0.00007)
            rr_ratio          : razão risco/retorno configurada (ex: 1.3)
            wr_rolling20      : WR dos últimos 20 trades (0.5 se sem histórico)
            sr_lookback       : lookback usado para calcular dist_topo/fundo
            bb_periodo        : período das Bollinger Bands

        Retorno:
            (deve_operar: bool, probabilidade: float)
            deve_operar = True se P(win) ≥ threshold
        """
        # Sem modelo → modo conservador: deixa passar (não bloqueia)
        # O bot opera normalmente sem ML até ter dados suficientes para treinar
        if not self.modelo_disponivel():
            return True, 0.5

        try:
            features = extrair_features(
                candles_ate_sinal=candles_ate_sinal,
                direcao=direcao,
                forca_rompimento=forca_rompimento,
                rr_ratio=rr_ratio,
                sr_lookback=sr_lookback,
                bb_periodo=bb_periodo,
                wr_rolling20=wr_rolling20,
            )

            import numpy as np
            X = np.array(features, dtype=float).reshape(1, -1)

            with self._lock_modelo:
                prob = float(self._modelo.predict_proba(X)[0, 1])

            deve_operar = prob >= self._threshold
            return deve_operar, prob

        except Exception as e:
            # Em caso de erro, deixa o sinal passar (não bloqueia)
            print(f"[PreditorML] ERRO na predição: {e} — sinal liberado")
            return True, 0.5

    def info(self) -> dict:
        """Retorna informações sobre o modelo carregado."""
        if not self.modelo_disponivel():
            return {'disponivel': False, 'motivo': 'modelo.pkl não encontrado'}

        m = self._metadados
        return {
            'disponivel':    True,
            'treinado_em':   m.get('treinado_em', ''),
            'n_trades':      m.get('n_trades', 0),
            'wr_historico':  m.get('wr_historico', 0),
            'threshold':     self._threshold,
            'metricas_oos':  m.get('metricas', {}),
        }


# ── Funções de conveniência (uso direto sem instanciar a classe) ─────────────

def filtrar_sinal(
    candles_ate_sinal: list,
    direcao: int,
    forca_rompimento: float,
    rr_ratio: float,
    wr_rolling20: float = 0.5,
    threshold: float = THRESHOLD_PADRAO,
) -> tuple[bool, float]:
    """
    Interface simplificada para uso no executor.py.

    Retorna (deve_operar, probabilidade_win).
    """
    preditor = PreditorML.obter(threshold=threshold)
    return preditor.filtrar(
        candles_ate_sinal=candles_ate_sinal,
        direcao=direcao,
        forca_rompimento=forca_rompimento,
        rr_ratio=rr_ratio,
        wr_rolling20=wr_rolling20,
    )


def modelo_info() -> dict:
    """Retorna status do modelo ML."""
    preditor = PreditorML.obter()
    return preditor.info()


def recarregar_modelo() -> bool:
    """Recarrega o modelo após retreino. Chamar do executor após train.py."""
    preditor = PreditorML.obter()
    return preditor.recarregar()


# ── Monitor de performance — decide quando retreinar ─────────────────────────

class MonitorPerformance:
    """
    Rastreia WR e PF rolling dos últimos N trades.
    Aciona retreino quando WR < 70% ou PF < 2.0.

    Integração: instanciar no executor.py e chamar .registrar_trade() após cada fechamento.
    """

    def __init__(
        self,
        janela: int = 20,
        wr_minimo: float = 0.70,
        pf_minimo: float = 2.0,
        caminho_trades: Optional[Path] = None,
    ):
        self._janela       = janela
        self._wr_minimo    = wr_minimo
        self._pf_minimo    = pf_minimo
        self._caminho      = caminho_trades or (BASE_DIR / 'data' / 'trades_historicos.csv')
        self._historico: list = []  # lista de dicts {timestamp, resultado, lucro_r}
        self._em_adaptacao = False
        self._lock         = threading.Lock()

    def registrar_trade(
        self,
        resultado: int,    # 1 = win, 0 = loss
        lucro_r: float,    # em múltiplos de R (ex: 1.3 win, -1.0 loss)
        timestamp: Optional[datetime] = None,
        dados_extras: Optional[dict] = None,
    ):
        """Registra resultado de um trade fechado."""
        if timestamp is None:
            timestamp = datetime.now(tz=timezone.utc)

        registro = {
            'timestamp': timestamp,
            'resultado': resultado,
            'lucro_r':   lucro_r,
        }
        if dados_extras:
            registro.update(dados_extras)

        with self._lock:
            self._historico.append(registro)

        self._avaliar_performance()

    def _calcular_metricas(self) -> tuple[float, float]:
        """Calcula WR e PF dos últimos N trades."""
        with self._lock:
            janela = self._historico[-self._janela:]

        if not janela:
            return 0.5, 1.0

        resultados = [t['resultado'] for t in janela]
        lucros_r   = [t['lucro_r'] for t in janela]

        n_wins  = sum(resultados)
        n_total = len(resultados)
        wr      = n_wins / n_total if n_total else 0

        ganhos = sum(r for r in lucros_r if r > 0)
        perdas = abs(sum(r for r in lucros_r if r < 0))
        pf     = ganhos / perdas if perdas > 0 else float('inf')

        return wr, pf

    def _avaliar_performance(self):
        """Verifica se WR ou PF caíram abaixo dos limiares e aciona retreino."""
        n = len(self._historico)
        if n < self._janela:
            return  # Aguarda trades suficientes

        wr, pf = self._calcular_metricas()

        performance_ok = wr >= self._wr_minimo and pf >= self._pf_minimo

        if not performance_ok and not self._em_adaptacao:
            self._em_adaptacao = True
            print(
                f"[MonitorPerformance] ⚠ MODO ADAPTAÇÃO ATIVADO\n"
                f"  WR={wr:.1%} (mín {self._wr_minimo:.0%}) | "
                f"PF={pf:.2f} (mín {self._pf_minimo:.1f})\n"
                f"  Iniciando retreino do modelo ML..."
            )
            self._retreinar_modelo()

        elif performance_ok and self._em_adaptacao:
            self._em_adaptacao = False
            print(
                f"[MonitorPerformance] ✓ MODO OBSERVAÇÃO — performance recuperada\n"
                f"  WR={wr:.1%} | PF={pf:.2f}"
            )

    def _retreinar_modelo(self):
        """Dispara retreino do XGBoost em thread separada (não bloqueia o bot)."""
        import subprocess
        import threading

        def _executar_treino():
            try:
                script = str(BASE_DIR / 'src' / 'ml' / 'train.py')
                trades = str(self._caminho)
                resultado = subprocess.run(
                    ['python', '-m', 'src.ml.train', '--trades', trades],
                    capture_output=True,
                    text=True,
                    cwd=str(BASE_DIR),
                    timeout=300,  # 5 minutos máximo
                )
                if resultado.returncode == 0:
                    print("[MonitorPerformance] ✓ Retreino concluído — recarregando modelo...")
                    recarregar_modelo()
                else:
                    print(f"[MonitorPerformance] ✗ Retreino falhou:\n{resultado.stderr}")
            except Exception as e:
                print(f"[MonitorPerformance] ERRO no retreino: {e}")
            finally:
                self._em_adaptacao = False

        t = threading.Thread(target=_executar_treino, daemon=True, name='retreino-ml')
        t.start()

    def status(self) -> dict:
        """Retorna status atual do monitor."""
        wr, pf = self._calcular_metricas()
        return {
            'n_trades_janela':  min(len(self._historico), self._janela),
            'n_trades_total':   len(self._historico),
            'wr_rolling':       round(wr, 4),
            'pf_rolling':       round(pf, 4),
            'modo':             'ADAPTAÇÃO' if self._em_adaptacao else 'OBSERVAÇÃO',
            'wr_minimo':        self._wr_minimo,
            'pf_minimo':        self._pf_minimo,
        }

    def wr_rolling(self) -> float:
        """Win rate dos últimos N trades (para feature wr_rolling20)."""
        wr, _ = self._calcular_metricas()
        return wr
