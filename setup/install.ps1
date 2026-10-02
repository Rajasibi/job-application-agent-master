# One-time install: Node.js, Ollama + Qwen model, n8n, Playwright + Chromium, config files.
# Re-runnable; anything already installed is skipped.

$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$N8nVersion = '2.14.2'   # pinned: newer releases have shipped with broken dependencies
function Refresh-Path { $env:Path = "$env:ProgramFiles\nodejs;$env:APPDATA\npm;$env:LOCALAPPDATA\Programs\Ollama;" + [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User') }
Refresh-Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host '[install] Node.js LTS'
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements
  Refresh-Path
}
Write-Host "[ok] Node $(node -v)"

if (-not (Get-Command ollama -ErrorAction SilentlyContinue)) {
  Write-Host '[install] Ollama'
  winget install --id Ollama.Ollama -e --silent --accept-package-agreements --accept-source-agreements
  Refresh-Path
}
Write-Host '[ok] Ollama installed'

if (-not (Test-Path (Join-Path $env:APPDATA 'npm\node_modules\n8n'))) {
  Write-Host "[install] n8n $N8nVersion (several minutes)"
  npm install -g "n8n@$N8nVersion"
}
Write-Host '[ok] n8n installed'

Write-Host '[install] Playwright dependencies + Chromium'
Push-Location (Join-Path $Root 'playwright')
npm install
npx playwright install chromium
Pop-Location

foreach ($pair in @(@('.env.example', '.env'), @('profile.example.json', 'profile.json'))) {
  $dst = Join-Path $Root $pair[1]
  if (-not (Test-Path $dst)) { Copy-Item (Join-Path $Root $pair[0]) $dst; Write-Host "[created] $($pair[1])" }
}
New-Item -ItemType Directory -Force (Join-Path $Root 'output') | Out-Null

try { Invoke-WebRequest 'http://127.0.0.1:11434/' -UseBasicParsing -TimeoutSec 3 | Out-Null } catch { Start-Process ollama -ArgumentList 'serve' -WindowStyle Hidden; Start-Sleep 5 }
Write-Host '[install] qwen2.5:7b-instruct model (~4.7 GB)'
ollama pull qwen2.5:7b-instruct

Write-Host ''
Write-Host 'Install complete. Next:'
Write-Host '  1. Fill profile.json and config\search.json (set "_configured": true)'
Write-Host '  2. setup\LOGIN_ONCE.bat            (save site logins)'
Write-Host '  3. powershell -File setup\import_workflows.ps1'
Write-Host '  4. START_AGENT.bat'
