<#
.SYNOPSIS
  Launches a process via CreateProcessW with CREATE_BREAKAWAY_FROM_JOB, falling back to a
  plain CreateProcessW (no breakaway) if the calling job's policy forbids it.

.DESCRIPTION
  job-core.mjs's launch() shells out to this script (itself spawned as a normal, non-detached
  child so its own job membership is whatever node.exe's happens to be) instead of spawning
  job-runner.mjs directly. Node's child_process has no option to request
  CREATE_BREAKAWAY_FROM_JOB, and relying on a Job Object's JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK
  happening to be set (observed on this install's Electron-managed job, but not guaranteed
  across Electron versions/installs) is not something to depend on silently. This script makes
  the escape explicit and deterministic: try CreateProcessW with the breakaway flag; if that
  fails with ERROR_ACCESS_DENIED (the job forbids breakaway), retry without it. Either way the
  target process starts -- worst case it stays nested in the caller's job, same as today.

  Exit code 0 = target process created (with or without breakaway). Non-zero = CreateProcessW
  failed outright; the 4th argument (a log file path) gets a diagnostic line appended.

  Environment: lpEnvironment is deliberately IntPtr.Zero (see Launch() below), meaning the target
  process inherits this wrapper's own environment block verbatim -- CreateProcessW copies it
  as-is when lpEnvironment is NULL, no re-encoding or registry merge involved. This wrapper is
  itself spawned by job-core.mjs's launchWin32() with no `env` override (inherits process.env),
  so the whole chain from the bridge process down to job-runner.mjs is pure inheritance with zero
  transformation at any hop *by this script*. Do NOT build a custom lpEnvironment block here --
  test/env-integrity.mjs proves this path and the pre-5a09feb direct-spawn path produce identical
  child environments for PATH, PATHEXT, and a random sentinel (not the full environment block --
  see that test's own header) given the same starting environment; a custom block would be new,
  unverified surface area solving a problem this code doesn't have.

  Caveat: this hop is not literally a no-op on the *hosting* powershell.exe process itself before
  CreateProcessW ever runs -- PowerShell's own startup can inject/alter a couple of variables in
  its process environment block ahead of whatever it inherited (confirmed empirically on this
  machine, powershell.exe -NoProfile -NonInteractive): it sets PSModulePath if the variable was
  absent, and defaults TEMP (observed; TMP was not defaulted in the same test) if absent. Since
  lpEnvironment=NULL means whatever is in *this* process's block at CreateProcessW time flows
  down verbatim, a caller missing PSModulePath/TEMP would see them appear from this hop, not from
  job-runner.mjs or the CLI. PATHEXT is the one variable this code deliberately overrides itself
  (sanitizeEnvForWin32, job-core.mjs) rather than leaving to chance.

.PARAMETER ExePath
  Full path to the executable to launch (node.exe).
.PARAMETER RunnerScript
  Full path to job-runner.mjs.
.PARAMETER SpecPath
  Full path to the job's spec.json.
.PARAMETER ErrLogPath
  Full path to the job's err.log, for best-effort diagnostics if CreateProcessW fails entirely.

.NOTES
  2026-09-09 runner-termination investigation: every outcome (not just total failure) is now
  logged UNCONDITIONALLY to <jobdir>/launch.log -- one line of "breakaway=ok",
  "breakaway=fallback(ERROR_ACCESS_DENIED)", or "breakaway=failed(<code>)", plus the created pid,
  the dwCreationFlags actually used, and whether this wrapper process itself was already in a Job
  Object at launch (IsProcessInJob on $PID) -- so a later reader can tell, from disk, whether a
  given job's runner ever actually escaped, without relying on err.log only getting a line on
  total failure. <jobdir> is derived from -SpecPath's directory (spec.json always lives in the job
  dir, same as launch.log). This never introduces a new exit-0-on-failure path: CreateProcessW
  failing outright still exits 1, same as before this instrumentation was added.
#>
param(
  [Parameter(Mandatory=$true)][string]$ExePath,
  [Parameter(Mandatory=$true)][string]$RunnerScript,
  [Parameter(Mandatory=$true)][string]$SpecPath,
  [Parameter(Mandatory=$true)][string]$ErrLogPath
)

$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class Breakaway {
    public const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    public const uint CREATE_NO_WINDOW = 0x08000000;
    public const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;
    public const int ERROR_ACCESS_DENIED = 5;

    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput, hStdOutput, hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessW(
        string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags,
        IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsProcessInJob(IntPtr ProcessHandle, IntPtr JobHandle, out bool Result);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    // Returns dwProcessId on success, or -(Win32 error code) on total failure.
    //
    // lpCurrentDirectory is deliberately never null: passing null (inherit the caller's native
    // CWD) was observed to fail unpredictably with ERROR_INVALID_NAME (123) in at least one real
    // PowerShell host process even though .NET's own Directory.GetCurrentDirectory() reported a
    // valid path for that same process -- passing an explicit, known-valid directory sidesteps
    // whatever that inconsistency is, and is more correct regardless (this process's own CWD is
    // never load-bearing here; job-runner.mjs re-applies the job's real cwd to its own child).
    public static int Launch(string exePath, string cmdLine, string cwd, bool breakaway)
    {
        var si = new STARTUPINFO();
        si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
        var pi = new PROCESS_INFORMATION();
        uint flags = CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP;
        if (breakaway) flags |= CREATE_BREAKAWAY_FROM_JOB;
        var sb = new StringBuilder(cmdLine);
        bool ok = CreateProcessW(exePath, sb, IntPtr.Zero, IntPtr.Zero, false, flags,
            IntPtr.Zero, cwd, ref si, out pi);
        if (!ok) return -Marshal.GetLastWin32Error();
        CloseHandle(pi.hThread);
        CloseHandle(pi.hProcess);
        return pi.dwProcessId;
    }
}
'@

$jobDir = Split-Path -Parent $SpecPath
$launchLog = Join-Path $jobDir "launch.log"

function Write-LaunchLog([string]$line) {
    $ts = (Get-Date).ToUniversalTime().ToString("o")
    try { Add-Content -Path $launchLog -Value "$ts $line" -Encoding utf8 } catch {}
}

try {
    Add-Type -TypeDefinition $code -ErrorAction Stop

    $wrapperInJobResult = $false
    $wrapperInJobOk = [Breakaway]::IsProcessInJob([Breakaway]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$wrapperInJobResult)
    $wrapperInJob = if ($wrapperInJobOk) { $wrapperInJobResult } else { "unknown" }

    function Quote($s) { '"' + $s + '"' }
    $cmdLine = (Quote $ExePath) + " " + (Quote $RunnerScript) + " " + (Quote $SpecPath)

    $flagsUsed = [Breakaway]::CREATE_NO_WINDOW -bor [Breakaway]::CREATE_NEW_PROCESS_GROUP -bor [Breakaway]::CREATE_BREAKAWAY_FROM_JOB
    $result = [Breakaway]::Launch($ExePath, $cmdLine, $PSScriptRoot, $true)
    $outcome = "ok"
    if ($result -lt 0) {
        $err = -$result
        if ($err -eq [Breakaway]::ERROR_ACCESS_DENIED) {
            # Ambient job forbids breakaway -- fall back to a plain launch (no worse than pre-fix).
            $flagsUsed = [Breakaway]::CREATE_NO_WINDOW -bor [Breakaway]::CREATE_NEW_PROCESS_GROUP
            $result = [Breakaway]::Launch($ExePath, $cmdLine, $PSScriptRoot, $false)
            $outcome = if ($result -lt 0) { "failed($(-$result))" } else { "fallback(ERROR_ACCESS_DENIED)" }
        } else {
            $outcome = "failed($err)"
        }
    }

    $pidStr = if ($result -ge 0) { $result } else { "n/a" }
    Write-LaunchLog "breakaway=$outcome pid=$pidStr flags=0x$($flagsUsed.ToString('X')) wrapperInJob=$wrapperInJob wrapperPid=$PID"

    if ($result -lt 0) {
        $msg = "[win32-breakaway] CreateProcessW failed err=$(-$result) exe=$ExePath cmdline=$cmdLine`n"
        try { Add-Content -Path $ErrLogPath -Value $msg -Encoding utf8 } catch {}
        exit 1
    }

    exit 0
} catch {
    Write-LaunchLog "breakaway=failed(exception) wrapperPid=$PID error=$($_.Exception.Message)"
    $msg = "[win32-breakaway] script threw: $($_.Exception.Message)`n$($_.ScriptStackTrace)`n"
    try { Add-Content -Path $ErrLogPath -Value $msg -Encoding utf8 } catch {}
    exit 1
}
