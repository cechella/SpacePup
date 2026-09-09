# iniciar_bots.ps1 — Inicia os 3 bots em janelas separadas
# Uso: .\iniciar_bots.ps1
# Execute na pasta C:\SpacePup\rafi-bot\

$raiz = $PSScriptRoot

Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$raiz'; py -m src.executor --broker exness" -WindowStyle Normal
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$raiz'; py -m src.executor --broker tickmill" -WindowStyle Normal
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$raiz'; py -m src.executor --broker pepperstone" -WindowStyle Normal

Write-Host "3 bots iniciados! Verifique as janelas abertas." -ForegroundColor Green
