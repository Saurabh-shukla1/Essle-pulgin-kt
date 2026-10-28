<#
  Registers the eSSL bridge as a Windows scheduled task that keeps running in
  the background (bridge.mjs --watch), with nobody logged in, and comes back
  after every reboot or crash.

  Run in an Administrator PowerShell from the essl-bridge folder:
    powershell -ExecutionPolicy Bypass -File install-task.ps1
    powershell -ExecutionPolicy Bypass -File install-task.ps1 -Uninstall

  The task runs as SYSTEM. It starts one minute after boot; a trigger every
  5 minutes acts as a watchdog: while the bridge is running those starts are
  skipped (no second copy), and if it has stopped they start it again.
  Intervals for commands and punches live in config.json
  (commandIntervalSeconds, punchIntervalMinutes).
#>
param(
  [string]$TaskName = "Omni eSSL Bridge",
  [switch]$Uninstall
)

$ErrorActionPreference = "Stop"

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw "Run this from an Administrator PowerShell."
}

if ($Uninstall) {
  try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch {}
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed scheduled task '$TaskName'."
  exit 0
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not (Test-Path (Join-Path $here "config.json"))) {
  throw "config.json not found in $here. Set it up and check 'node bridge.mjs --dry-run' works first."
}

# SYSTEM may not have the installing user's PATH, so pin node's full path now.
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not $nodeCmd) {
  throw "node not found on PATH. Install Node.js 18+ for all users, then rerun."
}
$node = $nodeCmd.Source

$runner = Join-Path $here "run-bridge.ps1"
$action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -Node "{1}" -Watch' -f $runner, $node) `
  -WorkingDirectory $here

$atStartup = New-ScheduledTaskTrigger -AtStartup
$atStartup.Delay = "PT1M"  # give the network and the eTimeTrackLite site a minute after boot
# Watchdog. No RepetitionDuration = repeat indefinitely.
$watchdog = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)

$settings = New-ScheduledTaskSettingsSet `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1)

$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

# Replacing an older install (the 5-minute one-shot task) stops it first.
try { Stop-ScheduledTask -TaskName $TaskName -ErrorAction Stop } catch {}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($atStartup, $watchdog) `
  -Settings $settings -Principal $principal -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Write-Host "Installed and started '$TaskName' (bridge.mjs --watch as SYSTEM)."
Write-Host "  node:  $node"
Write-Host "  logs:  $(Join-Path $here 'logs')"
Write-Host "Check status:   Get-ScheduledTaskInfo -TaskName '$TaskName'"
