@echo off
echo Iniciando bots RAFI...

start "RAFI - Pepperstone" cmd /k "cd /d C:\SpacePup\rafi-bot && py src/executor.py --broker pepperstone"
timeout /t 3 /nobreak >nul

start "RAFI - Exness" cmd /k "cd /d C:\SpacePup\rafi-bot && py src/executor.py --broker exness"
timeout /t 3 /nobreak >nul

start "RAFI - Tickmill" cmd /k "cd /d C:\SpacePup\rafi-bot && py src/executor.py --broker tickmill"

echo Todos os 3 bots iniciados!
