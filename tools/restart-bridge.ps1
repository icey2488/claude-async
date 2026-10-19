<#
.SYNOPSIS
  Deliberately restarts the claude-async bridge (claude-async-server.mjs), leaving a
  planned-restart marker first so claunker-ops's health-probe.ps1 doesn't page on the
  resulting BRIDGE DOWN.

.DESCRIPTION
  2026-10-18: multiple jobs (claunker.bg-wait-finite-ceiling-20261018-f0redi7r,
  claunker.bg-wait-merge-restart-20261018-thndanf1) restarted the bridge ad hoc -- find the
  node.exe pid(s) running claude-async-server.mjs, kill them, wait for Desktop to respawn on
  the next client reconnect. Nothing recorded that the resulting outage was expected, so the
  health probe's BRIDGE DOWN / RECOVERED Discord alerts fired for every one of them (the probe
  posted four times that afternoon). This script is now THE restart path (see RUNBOOK.md's
  "Restarting the bridge" section): it writes a single-line marker to bridge-restart.marker,
  next to bridge-crash.log (same JOB_ROOT exitWith() in claude-async-server.mjs uses), BEFORE
  killing anything, so the probe can tell a planned restart from a real outage.

  A forceful kill (what this script does, like Task Manager "End Process" or `taskkill /F`)
  gives the bridge process no chance to run its own exitWith() handler -- see
  claude-async-server.mjs's header comment -- which is exactly why the marker has to be written
  by the KILLER, not the bridge itself.

  The marker only covers ONE restart: claunker-ops's health-probe.ps1 clears its suppression
  once the bridge is seen recovered (or once it escalates a restart that never came back), so a
  stale leftover marker can never mask a later, unrelated outage.

.PARAMETER RequestedBy
  Free-text identifying who asked for this restart -- a claude-async job id, or "manual" for an
  interactive restart. Recorded verbatim in the marker and in any escalation alert text.

.PARAMETER WhatIf
  Reports the bridge pid(s) that would be killed and the marker that would be written, without
  writing the marker or killing anything. Safe to run any time to check what this script would
  do against the live bridge.

.NOTES
  Does not itself wait for or trigger a respawn -- per RUNBOOK.md, Desktop only relaunches the
  bridge on the next client reconnect (a `claude_jobs` warmup call), not proactively.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$RequestedBy = "manual"
)

$ErrorActionPreference = "Stop"

$JobRoot = if ($env:CLAUDE_ASYNC_JOB_DIR) { $env:CLAUDE_ASYNC_JOB_DIR } else { Join-Path $env:USERPROFILE ".claude-async-jobs" }
$MarkerPath = Join-Path $JobRoot "bridge-restart.marker"
$DesktopConfig = Join-Path $env:APPDATA "Claude\claude_desktop_config.json"

try {
  $cfg = Get-Content -LiteralPath $DesktopConfig -Raw | ConvertFrom-Json
  $serverScript = @($cfg.mcpServers.'claude-async'.args) | Where-Object { $_ -match 'claude-async-server\.mjs$' } | Select-Object -First 1
} catch {
  throw "Could not read $DesktopConfig to find the bridge script path: $($_.Exception.Message)"
}
if (-not $serverScript) {
  throw "No claude-async-server.mjs entry under mcpServers.claude-async in $DesktopConfig -- nothing to restart."
}

$pids = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($serverScript, [StringComparison]::OrdinalIgnoreCase) -ge 0 } |
    ForEach-Object { $_.ProcessId })

if ($pids.Count -eq 0) {
  Write-Output "No running node.exe process found for $serverScript -- nothing to restart."
  exit 0
}

Write-Output "Found bridge pid(s): $($pids -join ', ') running $serverScript"

if ($PSCmdlet.ShouldProcess(($pids -join ','), "write planned-restart marker and kill claude-async-server.mjs")) {
  $atUtc = [datetime]::UtcNow.ToString("o")
  $line = "planned-restart requested by=$RequestedBy pid=$($pids -join ',') at=$atUtc"
  New-Item -ItemType Directory -Force -Path $JobRoot | Out-Null
  Set-Content -LiteralPath $MarkerPath -Value $line -Encoding UTF8
  Write-Output "Wrote marker: $line"

  foreach ($p in $pids) {
    try {
      Stop-Process -Id $p -Force
      Write-Output "Killed pid $p"
    } catch {
      Write-Output "Failed to kill pid $p (already gone?): $($_.Exception.Message)"
    }
  }

  Write-Output "Bridge killed. Per RUNBOOK.md's 'Restarting the bridge' section: Desktop only"
  Write-Output "respawns it on the next client reconnect, so fire one throwaway claude_jobs call"
  Write-Output "as a warmup before any claude_start. The health probe will suppress BRIDGE"
  Write-Output "DOWN/RECOVERED alerts for this marker's window; if the bridge is still down past"
  Write-Output "that window it alerts normally that the planned restart did not come back."
}
