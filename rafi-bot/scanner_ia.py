"""
scanner_ia.py — Scanner contínuo da IA Autônoma (roda no VPS)

Chama /api/ml/auto-scan a cada 5 minutos durante as janelas de sessão.
Toda a inteligência (RAFI, similaridade, ordens) continua no Vercel.
Este script é só o "marcapasso" que garante varredura contínua.

Uso:  py scanner_ia.py
Stop: crie o arquivo STOP na pasta rafi-bot\
"""

import os
import time
import logging
from datetime import datetime, timezone, timedelta

try:
    import requests
except ImportError:
    print("Instale o requests: pip install requests")
    raise

# ── Configuração ───────────────────────────────────────────────────────────────
VERCEL_URL  = "https://space-pup.vercel.app"
CRON_SECRET = os.environ.get("CRON_SECRET", "rafi-ia-autonoma-2026-secret-xk9m")
INTERVALO_S = 5 * 60  # varre a cada 5 minutos (1 candle M5)

# Janelas de sessão em UTC: (hora_inicio, hora_fim)
# Quando inicio > fim, a sessão cruza a meia-noite (ex: 23h–04h)
SESSOES = [
    (23, 4,  "Sydney / Tóquio"),
    (4,  9,  "Tóquio / Londres"),
    (12, 16, "Londres / NY"),
]

# ── Logging ────────────────────────────────────────────────────────────────────
os.makedirs("logs", exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [scanner-ia] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    handlers=[
        logging.FileHandler("logs/scanner_ia.log", encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger(__name__)


def sessao_atual(h: int) -> str | None:
    """Retorna o nome da sessão ativa para a hora UTC, ou None se fora de sessão."""
    for ini, fim, nome in SESSOES:
        if ini < fim:
            if ini <= h < fim:
                return nome
        else:  # cruza meia-noite
            if h >= ini or h < fim:
                return nome
    return None


def segundos_para_proxima_sessao(h: int, m: int, s: int) -> int:
    """Calcula quantos segundos faltam para o início da próxima janela."""
    agora_min = h * 60 + m
    candidatos = []
    for ini, _, _ in SESSOES:
        ini_min = ini * 60
        diff = (ini_min - agora_min) % (24 * 60)
        if diff == 0:
            diff = 24 * 60
        candidatos.append(diff)
    prox_min = min(candidatos)
    return prox_min * 60 - s


def chamar_auto_scan() -> dict:
    """Chama o endpoint de auto-scan do Vercel e retorna o resultado."""
    try:
        resp = requests.get(
            f"{VERCEL_URL}/api/ml/auto-scan",
            headers={"Authorization": f"Bearer {CRON_SECRET}"},
            timeout=20,
        )
        resp.raise_for_status()
        return resp.json()
    except requests.exceptions.Timeout:
        return {"error": "timeout (>20s)"}
    except requests.exceptions.RequestException as e:
        return {"error": str(e)}
    except Exception as e:
        return {"error": f"inesperado: {e}"}


def dormir_com_stop_check(segundos: int) -> bool:
    """Dorme pelo tempo indicado, verificando arquivo STOP a cada 60s.
    Retorna True se STOP foi detectado."""
    dormido = 0
    while dormido < segundos:
        bloco = min(60, segundos - dormido)
        time.sleep(bloco)
        dormido += bloco
        if os.path.exists("STOP"):
            return True
    return False


def main():
    log.info("=" * 60)
    log.info("Scanner IA Autônoma iniciado")
    log.info(f"Endpoint: {VERCEL_URL}/api/ml/auto-scan")
    log.info(f"Intervalo: {INTERVALO_S // 60} minutos por candle M5")
    log.info("=" * 60)

    while True:
        # Kill switch manual
        if os.path.exists("STOP"):
            log.info("Arquivo STOP detectado — encerrando scanner.")
            break

        agora = datetime.now(timezone.utc)
        h, m, s = agora.hour, agora.minute, agora.second
        nome_sessao = sessao_atual(h)

        if nome_sessao:
            log.info(f"[{nome_sessao}] {h:02d}:{m:02d} UTC — varrendo mercado...")
            resultado = chamar_auto_scan()

            if resultado.get("executed"):
                log.info(
                    f"  ✓ ORDEM ENVIADA | "
                    f"{str(resultado.get('direction','')).upper()} | "
                    f"{resultado.get('lot')} lotes | "
                    f"P={resultado.get('probability')}% | "
                    f"TP={resultado.get('takeProfit')} | "
                    f"SL={resultado.get('stopLoss')}"
                )
            elif resultado.get("skipped"):
                motivo = resultado.get("reason", "—")
                log.info(f"  · Sem sinal: {motivo}")
            elif resultado.get("error"):
                log.warning(f"  ✗ Erro: {resultado.get('error')}")

            if dormir_com_stop_check(INTERVALO_S):
                log.info("STOP detectado durante espera — encerrando.")
                break

        else:
            espera = segundos_para_proxima_sessao(h, m, s)
            prox = agora + timedelta(seconds=espera)
            log.info(
                f"Fora de sessão ({h:02d}:{m:02d} UTC) — "
                f"próxima: {prox.strftime('%H:%M')} UTC "
                f"(em {espera // 3600}h {(espera % 3600) // 60}min)"
            )
            if dormir_com_stop_check(espera):
                log.info("STOP detectado durante espera — encerrando.")
                break


if __name__ == "__main__":
    main()
