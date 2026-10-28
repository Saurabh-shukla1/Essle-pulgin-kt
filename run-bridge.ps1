<#
  Runs the bridge with logging. Started by the scheduled task from install-task.ps1
  with -Watch (keeps running); safe to run by hand too:
    powershell -ExecutionPolicy Bypass -File run-bridge.ps1          # one pass
    powershell -ExecutionPolicy Bypass -File run-bridge.ps1 -Watch   # keep running

  Appends timestamped output to logs\bridge-yyyy-MM-dd.log (a new file each day,
  also while watching) and deletes logs older than $KeepDays. Exit code is the
  bridge's, so Task Scheduler's "Last Run Result" shows failures.
#>
param(
  [string]$Node = "node",
  [int]$KeepDays = 30,
  [switch]$Watch
)

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$logDir = Join-Path $here "logs"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Log([string]$line) {
  $now = Get-Date
  $logFile = Join-Path $logDir ("bridge-{0}.log" -f $now.ToString("yyyy-MM-dd"))
  Add-Content -Path $logFile -Value ("{0} {1}" -f $now.ToString("yyyy-MM-dd HH:mm:ss"), $line) -Encoding utf8
}

function Remove-OldLogs {
  Get-ChildItem -Path $logDir -Filter "bridge-*.log" |
    Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-$KeepDays) } |
    Remove-Item -Force -ErrorAction SilentlyContinue
}

Set-Location $here
Remove-OldLogs
$bridgeArgs = @((Join-Path $here "bridge.mjs"))
if ($Watch) { $bridgeArgs += "--watch" }
Write-Log ("run start" + $(if ($Watch) { " (watch)" } else { "" }))
# Native stderr arrives as ErrorRecords in Windows PowerShell; log its text either way.
& $Node @bridgeArgs 2>&1 | ForEach-Object { Write-Log ([string]$_) }
$code = $LASTEXITCODE
Write-Log "run end (exit $code)"
Remove-OldLogs

exit $code
