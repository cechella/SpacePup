# watchdog.ps1 - Mantem o bot vivo: reinicia automaticamente quando cai
#
# Uso:  .\watchdog.ps1 -Broker pepperstone
#
# Comportamento:
#   - Lanca o bot e aguarda terminar
#   - Se o bot sair por qualquer motivo (incluindo HALT Supabase), reinicia
#   - Se o arquivo STOP existir na pasta raiz, NAO reinicia (kill switch manual)
#   - Backoff progressivo entre reinicializacoes: 30s -> 60s -> ... -> 300s (max)
#   - Apos 30 reinicializacoes, desiste e alerta
#
# O watchdog e iniciado por iniciar_bots.ps1; cada broker roda em sua propria janela.

param(
    [Parameter(Mandatory=$true)]
    [string]$Broker
)

$raiz        = $PSScriptRoot
$maxReinicia = 30
$reiniciado  = 0
$esperaS     = 30
$tituloJanela = "WATCHDOG $($Broker.ToUpper())"

$host.UI.RawUI.WindowTitle = $tituloJanela

function Escrever-Cor($texto, $cor) {
    Write-Host $texto -ForegroundColor $cor
}

function Log-Watchdog($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $linha = "$ts [Watchdog/$Broker] $msg"
    Write-Host $linha -ForegroundColor Cyan
    $logDir = Join-Path $raiz "logs"
    if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
    Add-Content -Path (Join-Path $logDir "watchdog_$Broker.log") -Value $linha
}

Log-Watchdog "Watchdog iniciado para broker: $Broker"

while ($reiniciado -lt $maxReinicia) {

    # Kill switch manual - arquivo STOP na raiz do projeto
    if (Test-Path (Join-Path $raiz "STOP")) {
        Log-Watchdog "Arquivo STOP detectado. Encerrando watchdog sem reiniciar."
        break
    }

    Log-Watchdog "Iniciando bot (tentativa $($reiniciado + 1)/$maxReinicia)..."
    $host.UI.RawUI.WindowTitle = "$tituloJanela - rodando (boot $($reiniciado + 1))"

    # Executa o bot no mesmo processo/janela e aguarda terminar
    $proc = Start-Process `
        -FilePath    "py" `
        -ArgumentList "-m src.executor --broker $Broker" `
        -WorkingDirectory $raiz `
        -Wait `
        -PassThru `
        -NoNewWindow
    $exitCode = $proc.ExitCode

    # Verifica STOP apos bot encerrar
    if (Test-Path (Join-Path $raiz "STOP")) {
        Log-Watchdog "Arquivo STOP detectado apos encerramento (codigo $exitCode). Nao reiniciando."
        break
    }

    $reiniciado++
    $host.UI.RawUI.WindowTitle = "$tituloJanela - aguardando reinicio $reiniciado"

    Log-Watchdog "Bot encerrou (codigo $exitCode). Reiniciando em ${esperaS}s... ($reiniciado/$maxReinicia)"

    # Contagem regressiva visivel
    for ($i = $esperaS; $i -gt 0; $i--) {
        Write-Host -NoNewline "`r  Reiniciando $Broker em ${i}s...   "
        Start-Sleep -Seconds 1
        # Verifica STOP durante a espera
        if (Test-Path (Join-Path $raiz "STOP")) {
            Write-Host ""
            Log-Watchdog "STOP detectado durante espera. Abortando reinicio."
            exit 0
        }
    }
    Write-Host ""

    # Backoff: dobra a espera a cada reinicio, maximo 300s (5 min)
    $esperaS = [Math]::Min($esperaS * 2, 300)
}

if ($reiniciado -ge $maxReinicia) {
    Log-Watchdog "ALERTA: $maxReinicia reinicializacoes atingidas para $Broker. Desistindo."
    Escrever-Cor "Watchdog esgotado apos $maxReinicia reinicializacoes - reinicie manualmente via .\iniciar_bots.ps1" Red
}

Read-Host "Pressione Enter para fechar"
