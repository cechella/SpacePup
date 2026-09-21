"""
watchdog.py — Gerenciador de processos do Bot RAFI (multi-broker)

Roda como serviço Windows (via NSSM) e:
  - Inicia um executor por broker com bot_enabled=true ao subir
  - Relê comandos do Supabase: start / stop / restart (com broker_id)
  - Reinicia o executor automaticamente se ele cair por crash
  - PARAR pelo admin → executor do broker para limpo → não reinicia
  - INICIAR / REINICIAR pelo admin → watchdog sobe o executor do broker

Instalar como serviço (NSSM):
  nssm install RafiWatchdog "py" "-u watchdog.py"
  nssm set RafiWatchdog AppDirectory "C:\\SpacePup\\rafi-bot"
  nssm start RafiWatchdog

Kill switch de emergência:
  Crie o arquivo STOP_WATCHDOG na pasta rafi-bot\
  O watchdog para TODOS os executores e não reinicia até o arquivo ser removido.
"""

import os
import sys
import time
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
POLL_INTERVAL = 15    # segundos entre verificações de comando
RESTART_DELAY = 10    # segundos antes de reiniciar após crash
ARQUIVO_STOP  = Path('STOP_WATCHDOG')  # kill switch de emergência

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


def _brokers_habilitados() -> list[str]:
    """Retorna IDs dos brokers com enabled=true e bot_enabled=true no Supabase."""
    if supa is None:
        return []
    try:
        res = (
            supa.table('rafi_brokers')
            .select('id')
            .eq('enabled', True)
            .eq('bot_enabled', True)
            .execute()
        )
        return [r['id'] for r in (res.data or [])]
    except Exception as e:
        logger.warning(f"Erro ao carregar brokers habilitados: {e}")
        return []


def _ler_comando() -> tuple[str, str | None] | tuple[None, None]:
    """Lê e consome o próximo comando pendente do Supabase.
    Retorna (command, broker_id) ou (None, None).
    """
    if supa is None:
        return None, None
    try:
        res = (
            supa.table('rafi_bot_commands')
            .select('id,command,broker_id')
            .eq('pending', True)
            .in_('command', ['start', 'stop', 'restart'])
            .order('created_at')
            .limit(1)
            .execute()
        )
        if not res.data:
            return None, None
        row = res.data[0]
        supa.table('rafi_bot_commands').update({
            'pending':      False,
            'processed_at': datetime.now(timezone.utc).isoformat(),
        }).eq('id', row['id']).execute()
        return row['command'], row.get('broker_id')
    except Exception as e:
        logger.warning(f"Erro ao ler comando Supabase: {e}")
        return None, None


def _iniciar_executor(broker_id: str) -> subprocess.Popen:
    """Sobe o executor para um broker específico."""
    logger.info(f"▶ Iniciando executor [{broker_id}]...")
    proc = subprocess.Popen(
        [sys.executable, '-m', 'src.executor', '--broker', broker_id],
        cwd=str(Path(__file__).parent),
    )
    logger.info(f"  PID: {proc.pid} | broker: {broker_id}")
    logger.info(f"[Watchdog] Status: running [{broker_id}]")
    return proc


def _parar_executor(broker_id: str, proc: subprocess.Popen, timeout: int = 30) -> None:
    """Para o executor de um broker graciosamente (SIGTERM → espera → SIGKILL)."""
    if proc is None or proc.poll() is not None:
        return
    logger.info(f"■ Parando executor [{broker_id}] (PID {proc.pid})...")
    proc.terminate()
    try:
        proc.wait(timeout=timeout)
        logger.info(f"  Executor [{broker_id}] parou graciosamente.")
    except subprocess.TimeoutExpired:
        logger.warning(f"  Timeout [{broker_id}] — forçando SIGKILL...")
        proc.kill()
        proc.wait()
    logger.info(f"[Watchdog] Status: stopped [{broker_id}]")


def main() -> None:
    logger.info("=" * 55)
    logger.info("  Bot RAFI — Watchdog multi-broker iniciado")
    logger.info("=" * 55)

    # processos ativos: { broker_id: Popen }
    processos: dict[str, subprocess.Popen] = {}
    # brokers parados intencionalmente (não reiniciar no crash)
    paradas_intencionais: set[str] = set()

    # Inicia executores para todos os brokers habilitados ao subir
    if not ARQUIVO_STOP.exists():
        brokers_iniciais = _brokers_habilitados()
        if brokers_iniciais:
            logger.info(f"Brokers habilitados no startup: {brokers_iniciais}")
            for bid in brokers_iniciais:
                processos[bid] = _iniciar_executor(bid)
        else:
            logger.info("Nenhum broker com bot_enabled=true — aguardando comandos.")
    else:
        logger.warning(f"Kill switch ativo ({ARQUIVO_STOP}) — nenhum executor iniciado.")

    ultimo_poll = 0.0

    while True:
        # ── Kill switch de emergência ──────────────────────────────────────
        if ARQUIVO_STOP.exists():
            for bid, proc in list(processos.items()):
                if proc and proc.poll() is None:
                    logger.warning(f"Kill switch — parando [{bid}]...")
                    _parar_executor(bid, proc)
            processos.clear()
            time.sleep(5)
            continue

        # ── Verificar comando do admin (a cada POLL_INTERVAL s) ────────────
        agora = time.time()
        if agora - ultimo_poll >= POLL_INTERVAL:
            ultimo_poll = agora
            cmd, broker_id = _ler_comando()

            if cmd is not None:
                # Sem broker_id: aplica a TODOS os brokers habilitados (retrocompatibilidade)
                alvos: list[str] = []
                if broker_id:
                    alvos = [broker_id]
                elif cmd in ('stop', 'restart'):
                    alvos = list(processos.keys())
                elif cmd == 'start':
                    alvos = _brokers_habilitados()

                for bid in alvos:
                    if cmd == 'stop':
                        logger.info(f"[Admin] Comando STOP recebido [{bid}]")
                        paradas_intencionais.add(bid)
                        _parar_executor(bid, processos.pop(bid, None))

                    elif cmd == 'start':
                        logger.info(f"[Admin] Comando START recebido [{bid}]")
                        paradas_intencionais.discard(bid)
                        proc_existente = processos.get(bid)
                        if proc_existente is None or proc_existente.poll() is not None:
                            processos[bid] = _iniciar_executor(bid)
                        else:
                            logger.info(f"  Executor [{bid}] já está rodando — ignorado.")

                    elif cmd == 'restart':
                        logger.info(f"[Admin] Comando RESTART recebido [{bid}]")
                        paradas_intencionais.discard(bid)
                        _parar_executor(bid, processos.pop(bid, None))
                        time.sleep(2)
                        processos[bid] = _iniciar_executor(bid)

        # ── Verificar se algum executor caiu ──────────────────────────────
        for bid in list(processos.keys()):
            proc = processos[bid]
            if proc is not None and proc.poll() is not None:
                codigo = proc.returncode
                del processos[bid]

                if bid in paradas_intencionais:
                    logger.info(f"Executor [{bid}] encerrado (código {codigo}) — parada intencional.")
                else:
                    logger.warning(f"Executor [{bid}] caiu (código {codigo}) — reiniciando em {RESTART_DELAY}s...")
                    logger.info(f"[Watchdog] Status: restarting [{bid}]")
                    time.sleep(RESTART_DELAY)
                    if not ARQUIVO_STOP.exists():
                        processos[bid] = _iniciar_executor(bid)

        time.sleep(1)


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        logger.info("Watchdog encerrado por Ctrl+C.")
