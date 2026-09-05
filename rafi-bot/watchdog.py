"""
watchdog.py — Gerenciador de processo do Bot RAFI

Roda como serviço Windows (via NSSM) e:
  - Inicia o executor automaticamente ao subir
  - Relê comandos do Supabase: start / stop / restart
  - Reinicia o executor automaticamente se ele cair por crash
  - PARAR pelo admin → executor para limpo → watchdog aguarda → não reinicia
  - INICIAR / REINICIAR pelo admin → watchdog sobe o executor

Instalar como serviço (NSSM):
  nssm install RafiWatchdog "py" "-u watchdog.py"
  nssm set RafiWatchdog AppDirectory "C:\\SpacePup\\rafi-bot"
  nssm start RafiWatchdog

Kill switch de emergência:
  Crie o arquivo STOP_WATCHDOG na pasta rafi-bot\
  O watchdog para e não reinicia mais até o arquivo ser removido.
"""

import os
import sys
import time
import signal
import subprocess
import logging
from datetime import datetime, timezone
from pathlib import Path

# ── Logging ──────────────────────────────────────────────────────────────────
os.makedirs('logs', exist_ok=True)
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s | %(levelname)-8s | %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout),
        logging.FileHandler('logs/watchdog.log', encoding='utf-8'),
    ],
)
logger = logging.getLogger('watchdog')

# ── Configuração ─────────────────────────────────────────────────────────────
POLL_INTERVAL   = 15     # segundos entre verificações de comando
RESTART_DELAY   = 10     # segundos antes de reiniciar após crash
ARQUIVO_STOP    = Path('STOP_WATCHDOG')  # kill switch de emergência

# Carrega .env se existir
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

try:
    from supabase import create_client
    _url = os.getenv('SUPABASE_URL', '')
    _key = os.getenv('SUPABASE_KEY', '')
    supa = create_client(_url, _key) if (_url and _key) else None
except Exception:
    supa = None


def _ler_comando() -> str | None:
    """Lê e consome o próximo comando pendente do Supabase."""
    if supa is None:
        return None
    try:
        res = (
            supa.table('rafi_bot_commands')
            .select('id,command')
            .eq('pending', True)
            .in_('command', ['start', 'stop', 'restart'])
            .order('created_at')
            .limit(1)
            .execute()
        )
        if not res.data:
            return None
        row = res.data[0]
        supa.table('rafi_bot_commands').update({
            'pending': False,
            'processed_at': datetime.now(timezone.utc).isoformat(),
        }).eq('id', row['id']).execute()
        return row['command']
    except Exception as e:
        logger.warning(f"Erro ao ler comando Supabase: {e}")
        return None


def _publicar_status(status: str) -> None:
    """Loga o status do watchdog localmente (sem coluna dedicada no Supabase)."""
    logger.info(f"[Watchdog] Status: {status}")


def _iniciar_executor() -> subprocess.Popen:
    """Sobe o executor como subprocesso."""
    logger.info("▶ Iniciando executor...")
    proc = subprocess.Popen(
        [sys.executable, '-m', 'src.executor'],
        cwd=str(Path(__file__).parent),
    )
    logger.info(f"  PID: {proc.pid}")
    _publicar_status('running')
    return proc


def _parar_executor(proc: subprocess.Popen, timeout: int = 30) -> None:
    """Para o executor graciosamente (SIGTERM → espera → SIGKILL)."""
    if proc is None or proc.poll() is not None:
        return
    logger.info(f"■ Parando executor (PID {proc.pid})...")
    proc.terminate()
    try:
        proc.wait(timeout=timeout)
        logger.info("  Executor parou graciosamente.")
    except subprocess.TimeoutExpired:
        logger.warning("  Timeout — forçando SIGKILL...")
        proc.kill()
        proc.wait()
    _publicar_status('stopped')


def main() -> None:
    logger.info("=" * 55)
    logger.info("  Bot RAFI — Watchdog iniciado")
    logger.info("=" * 55)

    parada_intencional = False
    proc: subprocess.Popen | None = None

    # Inicia imediatamente ao subir (a menos que haja kill switch)
    if not ARQUIVO_STOP.exists():
        proc = _iniciar_executor()
    else:
        logger.warning(f"Kill switch ativo ({ARQUIVO_STOP}) — executor NÃO iniciado.")

    ultimo_poll = 0.0

    while True:
        # ── Kill switch de emergência ──────────────────────────────────────
        if ARQUIVO_STOP.exists():
            if proc and proc.poll() is None:
                logger.warning("Kill switch detectado — parando executor...")
                _parar_executor(proc)
                proc = None
            time.sleep(5)
            continue

        # ── Verificar comando do admin (a cada POLL_INTERVAL s) ────────────
        agora = time.time()
        if agora - ultimo_poll >= POLL_INTERVAL:
            ultimo_poll = agora
            cmd = _ler_comando()

            if cmd == 'stop':
                logger.info("[Admin] Comando STOP recebido")
                parada_intencional = True
                _parar_executor(proc)
                proc = None
                _publicar_status('stopped')

            elif cmd == 'start':
                logger.info("[Admin] Comando START recebido")
                parada_intencional = False
                if proc is None or proc.poll() is not None:
                    proc = _iniciar_executor()
                else:
                    logger.info("  Executor já está rodando — ignorado.")

            elif cmd == 'restart':
                logger.info("[Admin] Comando RESTART recebido")
                parada_intencional = False
                _parar_executor(proc)
                time.sleep(2)
                proc = _iniciar_executor()

        # ── Verificar se o executor caiu ───────────────────────────────────
        if proc is not None and proc.poll() is not None:
            codigo = proc.returncode
            proc = None

            if parada_intencional:
                logger.info(f"Executor encerrado (código {codigo}) — parada intencional, não reinicia.")
                _publicar_status('stopped')
            else:
                logger.warning(f"Executor caiu (código {codigo}) — reiniciando em {RESTART_DELAY}s...")
                _publicar_status('restarting')
                time.sleep(RESTART_DELAY)
                if not ARQUIVO_STOP.exists():
                    proc = _iniciar_executor()
                    parada_intencional = False

        time.sleep(1)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        logger.info("Watchdog encerrado por Ctrl+C.")
