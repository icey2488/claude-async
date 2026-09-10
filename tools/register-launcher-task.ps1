<#
.SYNOPSIS
  Idempotently (re)registers the `ClaudeAsyncRunner` scheduled task: a fixed, user-scope,
  no-elevation launcher that job-core.mjs triggers on win32 instead of spawning
  job-runner.mjs through Claude Desktop's own (job-object-encumbered) process tree.

.DESCRIPTION
  2026-09-09 runner-termination investigation: runners launched via CREATE_BREAKAWAY_FROM_JOB
  (win32-breakaway.ps1) still self-query as members of a Job Object with limitFlags 0x3C00 --
  the same flags as Claude Desktop's job -- and get hard-killed when that job closes. Breakaway
  only asks Windows nicely; Task Scheduler sidesteps the question entirely by giving the runner
  an ancestor (svchost's Task Scheduler service) that was never inside Desktop's job to begin
  with.

  The task's action is FIXED (always job-launcher.mjs, never a per-job commandline) because
  Register-ScheduledTask/Set-ScheduledTask calls are themselves slow (COM round-trips to the
  Task Scheduler service) -- too slow to do on every claude_start. job-core.mjs instead writes
  a launch.json spec to the job's directory and fires `schtasks /Run /TN ClaudeAsyncRunner`;
  job-launcher.mjs (started by the task) scans for pending specs and claims one. See
  job-launcher.mjs's own header for that side of the protocol.

  This script is safe to run repeatedly: it always calls Register-ScheduledTask with -Force,
  which replaces any existing task definition outright. job-core.mjs calls it only when the
  task is missing or its action path doesn't match the current repo/node location (see
  ensureLauncherTask() in job-core.mjs), so in steady state this script does not run at all.

.PARAMETER NodeExe
  Full path to node.exe (process.execPath from the calling node process).
.PARAMETER LauncherScript
  Full path to job-launcher.mjs.

.NOTES
  Logon type: -LogonType S4U was tried FIRST (it doesn't require the task to run only while the
  user is interactively logged on) and FAILED on this machine for a non-elevated, non-admin
  account: Register-ScheduledTask threw "Access is denied" outright, with no task created --
  most likely because granting/verifying SeBatchLogonRight for the target account is itself a
  privileged operation that this unelevated process can't perform. -LogonType Interactive was
  tried next and WORKS unelevated: Register-ScheduledTask succeeds and Get-ScheduledTaskInfo
  reports LastTaskResult 0 after a run. Interactive means the task can only run while that user
  has an interactive logon session -- acceptable here since claude-async's bridge itself only
  ever runs inside such a session (Claude Desktop is a desktop GUI app), so the task is never
  needed when nobody is logged on. This script uses Interactive; do not switch back to S4U
  without re-verifying on a machine where the account has SeBatchLogonRight already granted
  (e.g. via local security policy), since that's the likely difference.
#>
param(
  [Parameter(Mandatory=$true)][string]$NodeExe,
  [Parameter(Mandatory=$true)][string]$LauncherScript
)

$ErrorActionPreference = "Stop"
$TaskName = "ClaudeAsyncRunner"

try {
  $action = New-ScheduledTaskAction -Execute $NodeExe -Argument ('"' + $LauncherScript + '"')

  # ONCE at (effectively) the moment of registration; job-core.mjs never relies on this firing on
  # its own schedule -- it is always triggered on demand via `schtasks /Run /TN ClaudeAsyncRunner`.
  # A trigger is still required by the API to create a usable task at all.
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date)

  $settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances Parallel `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -Hidden
  # DontStopOnIdleEnd only applies when an idle trigger/condition is configured; this task has
  # neither (see -Once trigger above), so it's intentionally omitted rather than set on a
  # settings object that would silently ignore it.

  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force | Out-Null

  Write-Output "REGISTERED $TaskName action=`"$NodeExe`" `"$LauncherScript`" logonType=Interactive"
  exit 0
} catch {
  Write-Output "REGISTER_FAILED $($_.Exception.Message)"
  exit 1
}
