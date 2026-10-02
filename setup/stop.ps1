# Stops only the processes this project started (tracked by PID files). Ollama is left running.
param([string[]]$Only = @('helper', 'n8n', 'dashboard'))

$Logs = Join-Path (Split-Path $PSScriptRoot -Parent) 'setup\logs'
foreach ($name in $Only) {
  $pidFile = Join-Path $Logs "$name.pid"
  if (-not (Test-Path $pidFile)) { continue }
  $procId = [int](Get-Content $pidFile)
  if (Get-Process -Id $procId -ErrorAction SilentlyContinue) {
    & taskkill.exe /PID $procId /T /F | Out-Null
    Write-Host "[stopped] $name (pid $procId)"
  }
  Remove-Item $pidFile -Force
}
