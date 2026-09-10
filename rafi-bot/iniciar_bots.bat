@echo off
echo Iniciando bots RAFI...

start "RAFI - Pepperstone" powershell -NoExit -Command "cd C:\SpacePup\rafi-bot; py -m src.executor --broker pepperstone"
timeout /t 3 /nobreak >nul

start "RAFI - Exness" powershell -NoExit -Command "cd C:\SpacePup\rafi-bot; py -m src.executor --broker exness"
timeout /t 3 /nobreak >nul

start "RAFI - Tickmill" powershell -NoExit -Command "cd C:\SpacePup\rafi-bot; py -m src.executor --broker tickmill"

echo Todos os 3 bots iniciados!
