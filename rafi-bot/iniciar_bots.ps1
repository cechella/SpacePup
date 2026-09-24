# iniciar_bots.ps1 — Inicia os 3 bots com watchdog de auto-reinício
# Uso: .\iniciar_bots.ps1
# Execute na pasta C:\SpacePup\rafi-bot\
#
# Cada bot roda dentro de um watchdog que reinicia automaticamente se o processo cair
# (ex.: queda temporária do Supabase). Para parar definitivamente: crie o arquivo STOP
# na pasta rafi-bot\ ou use o kill switch do dashboard.

$raiz = $PSScriptRoot

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$raiz'; .\watchdog.ps1 -Broker exness" -WindowStyle Normal
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$raiz'; .\watchdog.ps1 -Broker tickmill" -WindowStyle Normal
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$raiz'; .\watchdog.ps1 -Broker pepperstone" -WindowStyle Normal
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$raiz'; py scanner_ia.py" -WindowStyle Normal

Write-Host "3 watchdogs + scanner IA iniciados! Verifique as janelas abertas." -ForegroundColor Green
Write-Host "Para parar todos: crie o arquivo STOP na pasta $raiz" -ForegroundColor Yellow
