@echo off
REM FloodShield AI - one-click startup (Windows, no GPU needed)
REM Opens 3 terminals: ML service :8000, Backend :8080, Frontend :5173
cd /d "%~dp0"
start "FloodShield-ML :8000" powershell -NoExit -Command "cd '%CD%\ml-service'; pip install -r requirements.txt; python app.py"
timeout /t 8 >nul
start "FloodShield-Backend :8080" powershell -NoExit -Command "cd '%CD%\backend'; if (Get-Command mvn -ErrorAction SilentlyContinue) { mvn spring-boot:run } else { & '%CD%\tools\maven\bin\mvn.cmd' spring-boot:run }"
start "FloodShield-Frontend :5173" powershell -NoExit -Command "cd '%CD%\frontend'; if (!(Test-Path node_modules)) { npm install }; npm run dev"
echo All three windows opened. Wait ~60s, then open http://localhost:5173
pause
