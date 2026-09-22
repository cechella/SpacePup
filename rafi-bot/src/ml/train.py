"""
train.py — Treina o classificador XGBoost para filtrar sinais de trading

Estratégia de treinamento:
  1. Carrega todos os trades históricos rotulados (resultado: ganho=1 / perda=0)
  2. Aplica peso temporal: trades recentes pesam mais (0.97 ^ dias_atrás)
  3. Treina XGBoost com os pesos
  4. Salva modelo + metadados em modelo.pkl

Uso:
  python -m src.ml.train --trades data/trades_historicos.csv
  python -m src.ml.train --trades data/trades_historicos.csv --threshold 0.65

O arquivo de trades deve ter pelo menos:
  timestamp, resultado (1=win/0=loss), direcao, forca_rompimento, rr_ratio
  + candles em JSON (coluna 'candles_json') OU as 12 features já calculadas.
"""

import argparse
import json
import os
import pickle
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd

# Adiciona raiz do projeto ao path
BASE_DIR = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(BASE_DIR))

from src.ml.feature_builder import (
    FEATURE_NAMES,
    N_FEATURES,
    extrair_features,
)

# ── Diretórios padrão ────────────────────────────────────────────────────────
DATA_DIR   = BASE_DIR / 'data'
MODELO_OUT = BASE_DIR / 'src' / 'ml' / 'modelo.pkl'

# ── Hiperparâmetros do XGBoost (conservadores para evitar overfitting) ───────
XGB_PARAMS = {
    'n_estimators':     300,
    'max_depth':        4,        # raso — estratégia com 12 features não precisa de mais
    'learning_rate':    0.05,
    'subsample':        0.8,
    'colsample_bytree': 0.8,
    'min_child_weight': 5,        # exige mínimo de amostras por folha
    'reg_alpha':        0.1,      # L1 regularização
    'reg_lambda':       1.0,      # L2 regularização
    'objective':        'binary:logistic',
    'eval_metric':      'auc',
    'use_label_encoder': False,
    'random_state':     42,
    'n_jobs':           -1,
}

# ── Fórmula de peso temporal ─────────────────────────────────────────────────
DECAY_RATE = 0.97  # por dia — trade de 100 dias atrás pesa 0.97^100 ≈ 4.8%


def calcular_pesos_temporais(timestamps: pd.Series) -> np.ndarray:
    """
    Calcula peso de cada trade baseado em quando ocorreu.
    Fórmula: peso = 0.97 ^ dias_atrás
    Trade de hoje → peso 1.0 | trade de 1 ano atrás → peso ≈ 1.1%
    """
    agora = pd.Timestamp.now(tz='UTC')
    if timestamps.dt.tz is None:
        timestamps = timestamps.dt.tz_localize('UTC')
    dias_atras = (agora - timestamps).dt.total_seconds() / 86400.0
    dias_atras = dias_atras.clip(lower=0)
    pesos = DECAY_RATE ** dias_atras
    # Normaliza para que a soma seja igual ao número de trades
    # (mantém escala do gradiente estável)
    pesos = pesos / pesos.mean()
    return pesos.values


def carregar_trades_csv(caminho: Path) -> pd.DataFrame:
    """
    Carrega CSV de trades históricos.

    Formato esperado (colunas mínimas):
      timestamp   : datetime ISO (ex: 2024-01-15 14:35:00)
      resultado   : 1 = win, 0 = loss
      direcao     : 1 = compra, -1 = venda
      forca_rompimento : float (em preço, ex: 0.00007)
      rr_ratio    : float (ex: 1.3)

    Formato alternativo (com features pré-calculadas):
      As 12 colunas de FEATURE_NAMES já presentes → usa diretamente

    Formato alternativo (com candles em JSON):
      candles_json : string JSON com lista de candles {time,open,high,low,close}
      → recalcula features automaticamente
    """
    df = pd.read_csv(caminho, parse_dates=['timestamp'])

    # Garante coluna de resultado binário
    if 'resultado' not in df.columns:
        raise ValueError("CSV precisa ter coluna 'resultado' (1=win, 0=loss)")
    if 'timestamp' not in df.columns:
        raise ValueError("CSV precisa ter coluna 'timestamp'")

    df['resultado'] = df['resultado'].astype(int)

    # Verifica se features já estão calculadas
    features_prontas = all(f in df.columns for f in FEATURE_NAMES)

    if features_prontas:
        print(f"  → Features já calculadas no CSV ({N_FEATURES} colunas)")
        return df

    # Tenta calcular features a partir de candles_json
    if 'candles_json' in df.columns:
        print("  → Calculando features a partir de candles_json...")
        feature_rows = []
        erros = 0
        for _, row in df.iterrows():
            try:
                candles = json.loads(row['candles_json'])
                feats = extrair_features(
                    candles_ate_sinal=candles,
                    direcao=row.get('direcao', 1),
                    forca_rompimento=row.get('forca_rompimento', 0.00005),
                    rr_ratio=row.get('rr_ratio', 1.3),
                )
            except Exception:
                feats = [0.0] * N_FEATURES
                erros += 1
            feature_rows.append(feats)

        features_df = pd.DataFrame(feature_rows, columns=FEATURE_NAMES)
        df = pd.concat([df.reset_index(drop=True), features_df], axis=1)
        if erros:
            print(f"  ⚠ {erros} trades com erro na extração de features (usados zeros)")
        return df

    # Tenta montar features básicas a partir das colunas disponíveis
    print("  → Montando features básicas (candles não disponíveis)...")
    for col in FEATURE_NAMES:
        if col not in df.columns:
            df[col] = 0.0  # fallback

    return df


def treinar(
    caminho_trades: str,
    threshold: float = 0.65,
    verbose: bool = True,
) -> dict:
    """
    Treina o classificador e salva o modelo.

    Retorna dict com métricas de avaliação (cross-validation temporal).
    """
    try:
        from xgboost import XGBClassifier
        from sklearn.model_selection import cross_val_score
        from sklearn.metrics import roc_auc_score, classification_report
    except ImportError as e:
        print(f"ERRO: dependência não instalada — {e}")
        print("Execute: pip install xgboost scikit-learn")
        sys.exit(1)

    # ── 1. Carrega dados ──────────────────────────────────────────────────────
    caminho = Path(caminho_trades)
    if not caminho.exists():
        print(f"ERRO: arquivo não encontrado: {caminho}")
        sys.exit(1)

    print(f"\nCarregando trades: {caminho.name}")
    df = carregar_trades_csv(caminho)
    print(f"  → {len(df):,} trades carregados")

    n_wins  = df['resultado'].sum()
    n_total = len(df)
    wr_raw  = n_wins / n_total if n_total else 0
    print(f"  → Win rate bruto: {wr_raw:.1%}  ({n_wins} wins / {n_total - n_wins} losses)")

    if n_total < 10:
        print(f"⚠ Apenas {n_total} trades rotulados — aguardando 10 para treinar.")
        return {}
    if n_total < 30:
        print(f"⚠ {n_total} trades — modelo inicial (melhora com mais dados).")

    # ── 2. Pesos temporais ────────────────────────────────────────────────────
    pesos = calcular_pesos_temporais(df['timestamp'])
    if verbose:
        print(f"  → Peso mínimo: {pesos.min():.4f}  |  máximo: {pesos.max():.4f}")

    # ── 3. Monta X e y ────────────────────────────────────────────────────────
    X = df[FEATURE_NAMES].values.astype(float)
    y = df['resultado'].values.astype(int)

    # ── 4. Treina modelo ──────────────────────────────────────────────────────
    print("\nTreinando XGBoost...")
    modelo = XGBClassifier(**XGB_PARAMS)
    modelo.fit(X, y, sample_weight=pesos)

    # ── 5. Avaliação walk-forward (split temporal 80/20) ──────────────────────
    split = int(len(df) * 0.80)
    X_oos = X[split:]
    y_oos = y[split:]

    metricas = {}
    if len(X_oos) >= 10:
        probs_oos = modelo.predict_proba(X_oos)[:, 1]
        preds_oos = (probs_oos >= threshold).astype(int)

        # Trades que passariam pelo filtro
        mask_filtrados = probs_oos >= threshold
        n_filtrados = mask_filtrados.sum()
        wr_filtrado  = y_oos[mask_filtrados].mean() if n_filtrados else 0

        auc = roc_auc_score(y_oos, probs_oos) if len(np.unique(y_oos)) > 1 else 0.5

        metricas = {
            'n_total_oos':      len(y_oos),
            'n_filtrados_oos':  int(n_filtrados),
            'wr_sem_filtro':    float(y_oos.mean()),
            'wr_com_filtro':    float(wr_filtrado),
            'auc_roc':          float(auc),
            'threshold':        threshold,
            'reducao_trades':   float(1 - n_filtrados / len(y_oos)) if len(y_oos) else 0,
        }

        if verbose:
            print(f"\n{'═'*55}")
            print(f"  AVALIAÇÃO OUT-OF-SAMPLE (últimos 20% dos trades)")
            print(f"{'═'*55}")
            print(f"  Trades OOS total     : {metricas['n_total_oos']:,}")
            print(f"  Passam pelo filtro   : {metricas['n_filtrados_oos']:,}"
                  f"  ({(1 - metricas['reducao_trades']):.1%} aprovados)")
            print(f"  WR sem filtro ML     : {metricas['wr_sem_filtro']:.1%}")
            print(f"  WR com filtro ML     : {metricas['wr_com_filtro']:.1%}")
            print(f"  AUC-ROC              : {metricas['auc_roc']:.3f}")
            print(f"{'═'*55}")

            melhoria = metricas['wr_com_filtro'] - metricas['wr_sem_filtro']
            if melhoria > 0.02:
                print(f"  ✓ Melhoria de {melhoria:.1%} no win rate com filtro ML")
            elif melhoria > 0:
                print(f"  ~ Melhoria marginal ({melhoria:.1%}) — mais dados necessários")
            else:
                print(f"  ⚠ Filtro ML não melhorou WR — modelo ainda aprendendo")
    else:
        print("  ⚠ Poucos trades OOS para avaliação confiável")

    # ── 6. Importância das features ───────────────────────────────────────────
    if verbose:
        importancias = modelo.feature_importances_
        ranking = sorted(zip(FEATURE_NAMES, importancias), key=lambda x: -x[1])
        print("\n  Importância das features (top 5):")
        for nome, imp in ranking[:5]:
            barra = '█' * int(imp * 40)
            print(f"    {nome:<20} {barra} {imp:.3f}")

    # ── 7. Salva modelo ───────────────────────────────────────────────────────
    pacote = {
        'modelo':        modelo,
        'feature_names': FEATURE_NAMES,
        'n_features':    N_FEATURES,
        'threshold':     threshold,
        'treinado_em':   datetime.now(tz=timezone.utc).isoformat(),
        'n_trades':      n_total,
        'wr_historico':  wr_raw,
        'metricas':      metricas,
        'xgb_params':    XGB_PARAMS,
    }

    MODELO_OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(MODELO_OUT, 'wb') as f:
        pickle.dump(pacote, f)

    print(f"\n✓ Modelo salvo: {MODELO_OUT}")
    print(f"  Treinado com {n_total:,} trades  |  threshold P(win) ≥ {threshold:.0%}")

    return metricas


def main():
    parser = argparse.ArgumentParser(
        description='Treina o classificador XGBoost para filtrar sinais RAFI'
    )
    parser.add_argument(
        '--trades',
        type=str,
        default=str(DATA_DIR / 'trades_historicos.csv'),
        help='Caminho para CSV de trades históricos rotulados',
    )
    parser.add_argument(
        '--threshold',
        type=float,
        default=0.65,
        help='Limiar mínimo de P(win) para abrir trade (padrão: 0.65)',
    )
    parser.add_argument(
        '--quiet',
        action='store_true',
        help='Suprime saída detalhada',
    )
    args = parser.parse_args()

    print('═' * 55)
    print('  TREINO ML — Filtro de Sinais RAFI (XGBoost)')
    print('═' * 55)

    treinar(
        caminho_trades=args.trades,
        threshold=args.threshold,
        verbose=not args.quiet,
    )


if __name__ == '__main__':
    main()


# ═══════════════════════════════════════════════════════════════════════════════
# TREINAMENTO DIRETO COM SUPABASE — chamado pelo executor quando recebe o
# comando 'treinar_xgboost' do dashboard (a cada novo trade rotulado).
# ═══════════════════════════════════════════════════════════════════════════════

def treinar_com_supabase(
    supa_url:  str,
    supa_key:  str,
    threshold: float = 0.65,
    verbose:   bool  = True,
) -> dict:
    """
    Carrega trades rotulados do Supabase, treina XGBoost e salva:
      - modelo.pkl localmente (para predictor.py)
      - importâncias das features de volta no Supabase (rafi_feature_importances)

    Retorna dict com métricas, ou {} se houver menos de 10 trades.

    Fluxo completo (a cada trade rotulado):
      Dashboard rotula trade → POST /api/ml/train → rafi_bot_commands.insert
      → executor.py detecta 'treinar_xgboost' → chama esta função
      → modelo.pkl atualizado → predictor.py recarrega
    """
    try:
        from xgboost import XGBClassifier
        from sklearn.model_selection import cross_val_score
    except ImportError:
        print("ERRO: pip install xgboost scikit-learn")
        return {}

    try:
        from supabase import create_client
    except ImportError:
        print("ERRO: pip install supabase")
        return {}

    from src.ml.feature_builder import (
        FEATURE_NAMES_SUPA,
        N_FEATURES_SUPA,
        extrair_features_supabase,
    )

    supa = create_client(supa_url, supa_key)

    # ── 1. Carrega trades rotulados do Supabase ───────────────────────────────
    res = (
        supa.table('rafi_trades')
        .select('id,time,result,direction,rafi,rafi_dir,bb_width,'
                'checkin_sono,checkin_energia,checkin_mental,checkin_humor')
        .in_('result', ['win', 'loss'])
        .order('time', desc=False)
        .execute()
    )
    trades = res.data or []
    n_total = len(trades)

    if verbose:
        print(f"\n[XGBoost] {n_total} trades rotulados carregados do Supabase")

    if n_total < 10:
        if verbose:
            print(f"[XGBoost] Aguardando 10 trades rotulados (atual: {n_total}) — treino adiado")
        return {'status': 'aguardando', 'n_trades': n_total}

    # ── 2. Monta features com win rate rolling ────────────────────────────────
    X_rows = []
    y_rows = []

    wins_acumulados = 0
    for i, row in enumerate(trades):
        # Win rate rolling: proporção de wins ANTES deste trade (sem lookahead)
        wr_rolling = wins_acumulados / i if i > 0 else 0.5
        feats = extrair_features_supabase(row, wr_rolling=wr_rolling)
        X_rows.append(feats)
        label = 1 if row['result'] == 'win' else 0
        y_rows.append(label)
        wins_acumulados += label

    import numpy as np
    X = np.array(X_rows, dtype=float)
    y = np.array(y_rows, dtype=int)

    n_wins = int(y.sum())
    wr_raw = n_wins / n_total
    if verbose:
        print(f"[XGBoost] Win rate bruto: {wr_raw:.1%} ({n_wins}W / {n_total - n_wins}L)")
        if n_total < 30:
            print(f"[XGBoost] Modelo inicial com {n_total} trades — melhora com mais dados")

    # ── 3. Pesos temporais (trades recentes pesam mais) ───────────────────────
    now_ts   = datetime.now(tz=timezone.utc).timestamp()
    trade_ts = np.array([int(t.get('time', now_ts)) for t in trades], dtype=float)
    dias_atras = np.clip((now_ts - trade_ts) / 86400.0, 0, None)
    pesos = DECAY_RATE ** dias_atras
    pesos = pesos / pesos.mean()

    # ── 4. Hiperparâmetros ajustados para poucos dados ────────────────────────
    # Com < 30 trades: árvores mais rasas, mais regularização
    params = dict(XGB_PARAMS)
    if n_total < 30:
        params['max_depth']        = 2
        params['n_estimators']     = 100
        params['min_child_weight'] = 1
    elif n_total < 60:
        params['max_depth']        = 3
        params['n_estimators']     = 150
        params['min_child_weight'] = 2

    # ── 5. Treina ─────────────────────────────────────────────────────────────
    modelo = XGBClassifier(**params)
    modelo.fit(X, y, sample_weight=pesos)

    # ── 6. Avaliação walk-forward (split 80/20) ───────────────────────────────
    metricas: dict = {}
    split = int(n_total * 0.80)
    X_oos, y_oos = X[split:], y[split:]

    if len(X_oos) >= 5:
        probs_oos = modelo.predict_proba(X_oos)[:, 1]
        mask = probs_oos >= threshold
        n_filtrados = int(mask.sum())
        wr_filtrado = float(y_oos[mask].mean()) if n_filtrados else 0.0

        from sklearn.metrics import roc_auc_score
        auc = float(roc_auc_score(y_oos, probs_oos)) if len(np.unique(y_oos)) > 1 else 0.5

        metricas = {
            'n_total':       n_total,
            'wr_raw':        round(wr_raw, 4),
            'n_oos':         len(y_oos),
            'n_filtrados':   n_filtrados,
            'wr_filtrado':   round(wr_filtrado, 4),
            'auc_roc':       round(auc, 4),
            'threshold':     threshold,
        }

        if verbose:
            print(f"[XGBoost] OOS {len(y_oos)} trades | filtrados {n_filtrados} "
                  f"| WR→{wr_filtrado:.1%} | AUC {auc:.3f}")

    # ── 7. Importância das features ───────────────────────────────────────────
    importancias = modelo.feature_importances_.tolist()
    ranking = sorted(
        zip(FEATURE_NAMES_SUPA, importancias),
        key=lambda x: -x[1],
    )
    if verbose:
        print("[XGBoost] Top features:")
        for nome, imp in ranking[:5]:
            print(f"  {nome:<20} {'█' * int(imp * 30)} {imp:.3f}")

    # ── 8. Salva modelo localmente ────────────────────────────────────────────
    pacote = {
        'modelo':        modelo,
        'feature_names': FEATURE_NAMES_SUPA,
        'n_features':    N_FEATURES_SUPA,
        'threshold':     threshold,
        'treinado_em':   datetime.now(tz=timezone.utc).isoformat(),
        'n_trades':      n_total,
        'wr_historico':  wr_raw,
        'metricas':      metricas,
        'xgb_params':    params,
        'fonte':         'supabase',
    }
    MODELO_OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(MODELO_OUT, 'wb') as f:
        pickle.dump(pacote, f)
    if verbose:
        print(f"[XGBoost] Modelo salvo → {MODELO_OUT}")

    # ── 9. Publica importâncias de volta no Supabase ──────────────────────────
    try:
        agora = datetime.now(tz=timezone.utc).isoformat()
        rows_imp = [
            {
                'feature':    nome,
                'importance': round(imp, 6),
                'rank':       i + 1,
                'n_trades':   n_total,
                'updated_at': agora,
            }
            for i, (nome, imp) in enumerate(ranking)
        ]
        # Upsert por feature (substitui linha existente)
        supa.table('rafi_feature_importances').upsert(
            rows_imp,
            on_conflict='feature',
        ).execute()

        # Salva métricas do treino
        supa.table('rafi_ml_models').upsert(
            [{
                'id':          'xgboost_v1',
                'n_trades':    n_total,
                'wr_raw':      round(wr_raw, 4),
                'wr_filtrado': round(metricas.get('wr_filtrado', 0), 4),
                'auc_roc':     round(metricas.get('auc_roc', 0), 4),
                'threshold':   threshold,
                'treinado_em': agora,
            }],
            on_conflict='id',
        ).execute()
        if verbose:
            print("[XGBoost] Importâncias publicadas no Supabase ✓")
    except Exception as e:
        print(f"[XGBoost] Aviso: não foi possível publicar no Supabase: {e}")

    metricas['status'] = 'ok'
    return metricas
