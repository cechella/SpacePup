# iniciar_bots.ps1 — Inicia os 4 bots com watchdog de auto-reinício
# Uso: .\iniciar_bots.ps1
# Execute na pasta C:\SpacePup\rafi-bot\
#
# Cada bot roda dentro de um watchdog que reinicia automaticamente se o processo cair
# (ex.: queda temporária do Supabase). Para parar definitivamente: crie o arquivo STOP
# na pasta rafi-bot\ ou use o kill switch do dashboard.
#
# Corretoras ativas:
#   exness      → C:\Program Files\MetaTrader 5 EXNESS\terminal64.exe
#   tickmill    → C:\Program Files\Tickmill UK MT5 Terminal\terminal64.exe
#   pepperstone → C:\Program Files\MetaTrader 5\terminal64.exe
#   icmarkets   → C:\Program Files\MetaTrader 5 IC Markets Global\terminal64.exe

$raiz = $PSScriptRoot

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$raiz'; .\watchdog.ps1 -Broker exness" -WindowStyle Normal
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$raiz'; .\watchdog.ps1 -Broker tickmill" -WindowStyle Normal
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$raiz'; .\watchdog.ps1 -Broker pepperstone" -WindowStyle Normal
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$raiz'; .\watchdog.ps1 -Broker icmarkets" -WindowStyle Normal
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$raiz'; py scanner_ia.py" -WindowStyle Normal

Write-Host "4 watchdogs + scanner IA iniciados! Verifique as janelas abertas." -ForegroundColor Green
Write-Host "Para parar todos: crie o arquivo STOP na pasta $raiz" -ForegroundColor Yellow
