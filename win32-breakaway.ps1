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

.PARAMETER ExePath
  Full path to the executable to launch (node.exe).
.PARAMETER RunnerScript
  Full path to job-runner.mjs.
.PARAMETER SpecPath
  Full path to the job's spec.json.
.PARAMETER ErrLogPath
  Full path to the job's err.log, for best-effort diagnostics if CreateProcessW fails entirely.
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

try {
    Add-Type -TypeDefinition $code -ErrorAction Stop

    function Quote($s) { '"' + $s + '"' }
    $cmdLine = (Quote $ExePath) + " " + (Quote $RunnerScript) + " " + (Quote $SpecPath)

    $result = [Breakaway]::Launch($ExePath, $cmdLine, $PSScriptRoot, $true)
    if ($result -lt 0) {
        $err = -$result
        if ($err -eq [Breakaway]::ERROR_ACCESS_DENIED) {
            # Ambient job forbids breakaway -- fall back to a plain launch (no worse than pre-fix).
            $result = [Breakaway]::Launch($ExePath, $cmdLine, $PSScriptRoot, $false)
        }
    }

    if ($result -lt 0) {
        $msg = "[win32-breakaway] CreateProcessW failed err=$(-$result) exe=$ExePath cmdline=$cmdLine`n"
        try { Add-Content -Path $ErrLogPath -Value $msg -Encoding utf8 } catch {}
        exit 1
    }

    exit 0
} catch {
    $msg = "[win32-breakaway] script threw: $($_.Exception.Message)`n$($_.ScriptStackTrace)`n"
    try { Add-Content -Path $ErrLogPath -Value $msg -Encoding utf8 } catch {}
    exit 1
}
