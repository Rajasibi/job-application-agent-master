# Imports the workflows into n8n, activates them, and restarts n8n so the webhooks and
# schedules register.
# Safe to re-run after editing workflow JSONs: existing workflows with the same id are replaced.

$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$env:Path = "$env:ProgramFiles\nodejs;$env:APPDATA\npm;$env:Path"
$n8n = Join-Path $env:APPDATA 'npm\node_modules\n8n\bin\n8n'
if (-not (Test-Path $n8n)) { throw 'n8n not installed. Run setup\install.ps1 first.' }

function Invoke-N8n([string[]]$CliArgs) {
  & node $n8n @CliArgs 2>&1 | Where-Object { $_ -notmatch 'DeprecationWarning|trace-deprecation' } | ForEach-Object { "    $_" }
  if ($LASTEXITCODE -ne 0) { throw "n8n $($CliArgs -join ' ') failed" }
}

& (Join-Path $PSScriptRoot 'stop.ps1') -Only n8n

$files = @(Get-ChildItem (Join-Path $Root 'core\*.json'), (Join-Path $Root 'agents\*.json'), (Join-Path $Root 'scrapers\*.json'))
foreach ($f in $files) {
  Write-Host "[import] $($f.Name)"
  Invoke-N8n @('import:workflow', "--input=$($f.FullName)")
}

# Google Sheets is synced by the helper service in the background (helper-service\sheets_sync.js,
# key file config\google-service-account.json), so n8n needs no Google credential.

# Job searches run as VISIBLE searches from the helper (dashboard buttons + its 2x/day schedule in
# config\search.json). The headless n8n scraper schedules were always blocked by the sites, so all
# scraper workflows stay imported but switched off.
$ids = 'fit-scorer-workflow', 'cv-builder-workflow', 'app-logger-workflow',
       'india-agent-workflow', 'abroad-agent-workflow', 'tier1-agent-workflow'
$disabledIds = 'linkedin-scraper-workflow', 'wttj-scraper-workflow', 'tier1-scraper-workflow', 'indeed-scraper-workflow',
               'naukri-scraper-workflow', 'foundit-scraper-workflow'
foreach ($id in $ids) {
  Write-Host "[activate] $id"
  Invoke-N8n @('publish:workflow', "--id=$id")
}
foreach ($id in $disabledIds) {
  Write-Host "[deactivate] $id"
  & node $n8n unpublish:workflow "--id=$id" 2>&1 | Out-Null  # fails harmlessly if already unpublished
}

Write-Host ''
Write-Host 'Imported and activated. Starting n8n...'
& (Join-Path $PSScriptRoot 'start.ps1') -NoBrowser
