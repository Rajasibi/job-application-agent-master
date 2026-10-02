# Starts the Job Agent: Ollama, helper service (:9999), n8n (:5678), dashboard (:8765).
# Idempotent: anything already running is left alone. Only this project's processes are tracked (PID files).
param([switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Logs = Join-Path $Root 'setup\logs'
New-Item -ItemType Directory -Force $Logs | Out-Null
$env:Path = "$env:ProgramFiles\nodejs;$env:APPDATA\npm;$env:LOCALAPPDATA\Programs\Ollama;$env:Path"

function Test-Url([string]$Url) {
  try { Invoke-WebRequest $Url -UseBasicParsing -TimeoutSec 3 | Out-Null; return $true } catch { return $false }
}

function Wait-Url([string]$Url, [int]$Seconds) {
  for ($i = 0; $i -lt $Seconds; $i += 2) { if (Test-Url $Url) { return $true }; Start-Sleep 2 }
  return $false
}

function Start-Tracked([string]$Name, [string]$File, [string[]]$Arguments) {
  $p = Start-Process -FilePath $File -ArgumentList $Arguments -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $Logs "$Name.log") -RedirectStandardError (Join-Path $Logs "$Name-err.log")
  Set-Content -Path (Join-Path $Logs "$Name.pid") -Value $p.Id
}

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js not found. Run setup\install.ps1 first.' }
$n8nBin = Join-Path $env:APPDATA 'npm\node_modules\n8n\bin\n8n'
if (-not (Test-Path $n8nBin)) { throw 'n8n not found. Run setup\install.ps1 first.' }
if (-not (Test-Path (Join-Path $Root '.env'))) { throw '.env missing. Copy .env.example to .env first.' }

# On the cloud LLM backend, local Qwen is only a fallback: don't preload it, and let it unload soon.
$cloud = [bool](Select-String -Path (Join-Path $Root '.env') -Pattern '^LLM_BACKEND=ollama_cloud\s*$' -Quiet)

# 1. Ollama
if (Test-Url 'http://127.0.0.1:11434/') {
  Write-Host '[ok] Ollama already running'
} else {
  $ollama = (Get-Command ollama -ErrorAction SilentlyContinue).Source
  if (-not $ollama) { throw 'Ollama not found. Run setup\install.ps1 first.' }
  $env:OLLAMA_KEEP_ALIVE = $(if ($cloud) { '10m' } else { '2h' })
  Start-Process -FilePath $ollama -ArgumentList 'serve' -WindowStyle Hidden
  if (Wait-Url 'http://127.0.0.1:11434/' 30) { Write-Host '[ok] Ollama started' } else { Write-Warning 'Ollama did not respond' }
}

# 2. Helper service
if (Test-Url 'http://127.0.0.1:9999/health') {
  Write-Host '[ok] Helper already running'
} else {
  Start-Tracked 'helper' $node @('"' + (Join-Path $Root 'helper-service\server.js') + '"')
  if (Wait-Url 'http://127.0.0.1:9999/health' 20) { Write-Host '[ok] Helper started on :9999' } else { Write-Warning "Helper failed; see $Logs\helper-err.log" }
}

# 3. n8n
if (Test-Url 'http://127.0.0.1:5678/healthz') {
  Write-Host '[ok] n8n already running'
} else {
  $env:N8N_PORT = '5678'
  $env:N8N_DIAGNOSTICS_ENABLED = 'false'
  $env:N8N_PERSONALIZATION_ENABLED = 'false'
  $env:N8N_VERSION_NOTIFICATIONS_ENABLED = 'false'
  $env:EXECUTIONS_DATA_PRUNE = 'true'
  $env:EXECUTIONS_DATA_MAX_AGE = '336'
  # Save each node's result as it finishes, so a stuck run shows where it stopped.
  $env:EXECUTIONS_DATA_SAVE_ON_PROGRESS = 'true'
  if (-not $env:GENERIC_TIMEZONE) { $env:GENERIC_TIMEZONE = 'Asia/Kolkata' }
  Start-Tracked 'n8n' $node @('"' + $n8nBin + '"', 'start')
  Write-Host '... waiting for n8n (first start can take a minute)'
  if (Wait-Url 'http://127.0.0.1:5678/healthz' 120) { Write-Host '[ok] n8n started on :5678' } else { Write-Warning "n8n failed; see $Logs\n8n-err.log" }
}

# 4. Dashboard
if (Test-Url 'http://127.0.0.1:8765/') {
  Write-Host '[ok] Dashboard already running'
} else {
  Start-Tracked 'dashboard' $node @('"' + (Join-Path $Root 'dashboard\server.cjs') + '"')
  if (Wait-Url 'http://127.0.0.1:8765/' 15) { Write-Host '[ok] Dashboard on http://127.0.0.1:8765/' }
}

# Local backend: warm up the model in the background so the first job doesn't hit a cold start.
if (-not $cloud) {
  $model = (Select-String -Path (Join-Path $Root '.env') -Pattern '^OLLAMA_MODEL=(.+)$' | Select-Object -First 1).Matches.Groups[1].Value
  if (-not $model) { $model = 'qwen2.5:7b-instruct' }
  Start-Job -ScriptBlock { param($m) try { Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:11434/api/generate' -Body (@{ model = $m; prompt = ''; keep_alive = '2h' } | ConvertTo-Json) -TimeoutSec 300 | Out-Null } catch {} } -ArgumentList $model | Out-Null
} else {
  Write-Host '[ok] LLM backend: Ollama Cloud (local Qwen is the fallback; not preloaded)'
}

Write-Host ''
Write-Host 'Job Agent is running. n8n: http://localhost:5678   Dashboard: http://127.0.0.1:8765/'
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8765/' }
