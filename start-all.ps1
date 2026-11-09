# FloodShield AI — robust startup (PowerShell)
# Runs DB + ML + backend SUPERVISED under Docker (auto-restart on crash/reboot),
# then starts the Vite frontend in a window. Re-run any time; it's idempotent.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

if (!(Get-Command docker -ErrorAction SilentlyContinue)) {
  Write-Error "Docker Desktop is required. Install it, start it, then re-run this script."
  exit 1
}

Write-Output "→ Starting db + ml-service + backend (supervised, restart unless-stopped)…"
docker compose up -d --build db ml-service backend
if ($LASTEXITCODE -ne 0) { Write-Error "docker compose failed — is Docker Desktop running?"; exit 1 }

Write-Output "→ Waiting for backend :8080…"
$deadline = (Get-Date).AddMinutes(5)
while ((Get-Date) -lt $deadline) {
  try {
    $r = Invoke-WebRequest "http://localhost:8080/api/projects" -TimeoutSec 5 -UseBasicParsing
    if ($r.StatusCode -eq 200) { break }
  } catch { Start-Sleep -Seconds 5 }
}
Write-Output "→ Starting frontend…"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontend'; if (!(Test-Path node_modules)) { npm install }; npm run dev"
Write-Output "Open http://localhost:5173 (or the port Vite prints). API health: docker compose ps"
