# ============================================================
# instalar_vps.ps1 — Setup completo do Bot RAFI no VPS Windows
#
# USO: abra PowerShell como Administrador e cole:
#   Set-ExecutionPolicy Bypass -Scope Process -Force
#   irm https://raw.githubusercontent.com/cechella/SpacePup/main/rafi-bot/instalar_vps.ps1 | iex
#
# Ou copie este arquivo para o VPS e execute:
#   powershell -ExecutionPolicy Bypass -File instalar_vps.ps1
# ============================================================

$ErrorActionPreference = "Stop"
$PASTA   = "C:\RafiBot"
$REPO    = "https://github.com/cechella/SpacePup.git"
$PYTHON  = "https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe"

Write-Host ""
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "  BOT RAFI — Instalacao automatica no VPS Windows" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ── 1. Python ────────────────────────────────────────────────
Write-Host "[1/5] Verificando Python..." -ForegroundColor Yellow
$pythonOk = $null
try { $pythonOk = (python --version 2>&1) -match "3\." } catch {}

if (-not $pythonOk) {
    Write-Host "      Baixando Python 3.11..." -ForegroundColor Gray
    $tmp = "$env:TEMP\python_installer.exe"
    Invoke-WebRequest -Uri $PYTHON -OutFile $tmp -UseBasicParsing
    Write-Host "      Instalando Python (pode demorar 1-2 min)..." -ForegroundColor Gray
    Start-Process -FilePath $tmp -ArgumentList "/quiet InstallAllUsers=1 PrependPath=1" -Wait
    # Recarrega PATH
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")
    Write-Host "      Python instalado!" -ForegroundColor Green
} else {
    Write-Host "      Python ja instalado: $(python --version)" -ForegroundColor Green
}

# ── 2. Git ───────────────────────────────────────────────────
Write-Host "[2/5] Verificando Git..." -ForegroundColor Yellow
$gitOk = $null
try { $gitOk = (git --version 2>&1) -match "git" } catch {}

if (-not $gitOk) {
    Write-Host "      Baixando Git..." -ForegroundColor Gray
    $gitUrl = "https://github.com/git-for-windows/git/releases/download/v2.44.0.windows.1/Git-2.44.0-64-bit.exe"
    $gitTmp = "$env:TEMP\git_installer.exe"
    Invoke-WebRequest -Uri $gitUrl -OutFile $gitTmp -UseBasicParsing
    Start-Process -FilePath $gitTmp -ArgumentList "/VERYSILENT /NORESTART" -Wait
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path","User")
    Write-Host "      Git instalado!" -ForegroundColor Green
} else {
    Write-Host "      Git ja instalado." -ForegroundColor Green
}

# ── 3. Clonar repositorio ────────────────────────────────────
Write-Host "[3/5] Clonando repositorio..." -ForegroundColor Yellow
if (Test-Path "$PASTA") {
    Write-Host "      Pasta ja existe — atualizando..." -ForegroundColor Gray
    Set-Location "$PASTA"
    git pull origin main
} else {
    git clone $REPO $PASTA
    Set-Location "$PASTA"
}
Set-Location "$PASTA\rafi-bot"
Write-Host "      Repositorio pronto em $PASTA" -ForegroundColor Green

# ── 4. Dependencias Python ───────────────────────────────────
Write-Host "[4/5] Instalando dependencias Python..." -ForegroundColor Yellow
python -m pip install --upgrade pip --quiet
python -m pip install -r requirements.txt --quiet
Write-Host "      Dependencias instaladas!" -ForegroundColor Green

# ── 5. Configurar .env ───────────────────────────────────────
Write-Host "[5/5] Configurando .env..." -ForegroundColor Yellow
$envFile = "$PASTA\rafi-bot\.env"

if (-not (Test-Path $envFile)) {
    # Pede as chaves do Supabase
    Write-Host ""
    Write-Host "  Encontre suas chaves em:" -ForegroundColor Cyan
    Write-Host "  https://supabase.com/dashboard -> Settings -> API" -ForegroundColor Cyan
    Write-Host ""
    $supUrl = Read-Host "  Cole sua SUPABASE_URL (https://xxxx.supabase.co)"
    $supKey = Read-Host "  Cole sua SUPABASE_KEY (eyJhbGci...)"

    @"
SUPABASE_URL=$supUrl
SUPABASE_KEY=$supKey
"@ | Set-Content $envFile -Encoding UTF8

    Write-Host "      .env criado!" -ForegroundColor Green
} else {
    Write-Host "      .env ja existe — mantido." -ForegroundColor Green
}

# ── Cria atalho para rodar o bot ─────────────────────────────
$atalhoPath = "$env:USERPROFILE\Desktop\Rodar Bot RAFI.bat"
@"
@echo off
title Bot RAFI - EURUSD M5
cd /d $PASTA\rafi-bot
echo Iniciando Bot RAFI...
python -m src.executor
pause
"@ | Set-Content $atalhoPath -Encoding UTF8

# ── Cria atalho de kill switch ───────────────────────────────
$killPath = "$env:USERPROFILE\Desktop\PARAR Bot RAFI.bat"
@"
@echo off
echo Parando Bot RAFI...
echo. > $PASTA\rafi-bot\STOP
echo Bot sera parado no proximo ciclo (maximo 5 min).
pause
"@ | Set-Content $killPath -Encoding UTF8

# ── Resumo ───────────────────────────────────────────────────
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  INSTALACAO CONCLUIDA!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Pasta:   $PASTA\rafi-bot" -ForegroundColor White
Write-Host "  Config:  $PASTA\rafi-bot\config.yaml" -ForegroundColor White
Write-Host "  Log:     $PASTA\rafi-bot\logs\rafi_bot.log" -ForegroundColor White
Write-Host ""
Write-Host "  PARA RODAR O BOT:" -ForegroundColor Cyan
Write-Host "  Clique duas vezes em 'Rodar Bot RAFI' na Area de Trabalho" -ForegroundColor White
Write-Host "  Ou no terminal:" -ForegroundColor White
Write-Host "  cd $PASTA\rafi-bot && python -m src.executor" -ForegroundColor Yellow
Write-Host ""
Write-Host "  PARA PARAR:" -ForegroundColor Cyan
Write-Host "  Clique duas vezes em 'PARAR Bot RAFI' na Area de Trabalho" -ForegroundColor White
Write-Host "  Ou: Ctrl+C no terminal" -ForegroundColor White
Write-Host ""
Write-Host "  IMPORTANTE: O MT5 da XM precisa estar aberto e logado!" -ForegroundColor Red
Write-Host ""
