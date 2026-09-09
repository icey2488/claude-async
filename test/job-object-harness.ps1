<#
.SYNOPSIS
  Test harness for test/detach-survival.mjs. Creates a throwaway Job Object with the given
  LimitFlags, launches the "parent" node process (P) suspended, assigns it to the job, resumes
  it, writes P's pid to -ParentPidFile, then blocks forever holding the job handle open.

.DESCRIPTION
  The orchestrating node script kills THIS process directly by pid (no /T, so taskkill never
  touches P or its descendants itself) once it's confirmed the runner job has been launched.
  Killing this process closes its (only) handle to the Job Object; with
  JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE set, that's what terminates every process still nested in
  the job -- exactly the mechanism hypothesized for the original bug, not taskkill's own
  tree-walk. Whatever survives that is what escaped the job (via breakaway, if the fix is in
  place) versus what didn't (if it isn't).
#>
param(
  [Parameter(Mandatory=$true)][string]$NodeExe,
  [Parameter(Mandatory=$true)][string]$ParentScript,
  [Parameter(Mandatory=$true)][string]$JobDir,
  [Parameter(Mandatory=$true)][string]$DummyCli,
  [Parameter(Mandatory=$true)][string]$CoreModule,
  [Parameter(Mandatory=$true)][string]$MarkerPath,
  [Parameter(Mandatory=$true)][string]$ParentPidFile,
  [uint32]$JobFlags = 0x2800  # KILL_ON_JOB_CLOSE (0x2000) | BREAKAWAY_OK (0x0800), no SILENT
)

$code = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class JobHarness {
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
        public Int64 PerProcessUserTimeLimit;
        public Int64 PerJobUserTimeLimit;
        public UInt32 LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public UInt32 ActiveProcessLimit;
        public IntPtr Affinity;
        public UInt32 PriorityClass;
        public UInt32 SchedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS {
        public UInt64 ReadOperationCount, WriteOperationCount, OtherOperationCount;
        public UInt64 ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved, lpDesktop, lpTitle;
        public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute;
        public int dwFlags;
        public short wShowWindow, cbReserved2;
        public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
    }
    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess, hThread;
        public int dwProcessId, dwThreadId;
    }

    public const uint CREATE_SUSPENDED = 0x00000004;
    public const int JobObjectExtendedLimitInformation = 9;

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateJobObjectW(IntPtr a, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int cls, IntPtr info, uint len);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessW(
        string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags,
        IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern int ResumeThread(IntPtr hThread);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);
}
'@

Add-Type -TypeDefinition $code -ErrorAction Stop

$hJob = [JobHarness]::CreateJobObjectW([IntPtr]::Zero, $null)
if ($hJob -eq [IntPtr]::Zero) { throw "CreateJobObjectW failed err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

$sz = [System.Runtime.InteropServices.Marshal]::SizeOf([type][JobHarness+JOBOBJECT_EXTENDED_LIMIT_INFORMATION])
$buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($sz)
try {
    for ($i = 0; $i -lt $sz; $i++) { [System.Runtime.InteropServices.Marshal]::WriteByte($buf, $i, 0) }
    $basic = New-Object JobHarness+JOBOBJECT_BASIC_LIMIT_INFORMATION
    $basic.LimitFlags = $JobFlags
    $info = New-Object JobHarness+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    $info.BasicLimitInformation = $basic
    [System.Runtime.InteropServices.Marshal]::StructureToPtr($info, $buf, $false)
    $ok = [JobHarness]::SetInformationJobObject($hJob, [JobHarness]::JobObjectExtendedLimitInformation, $buf, $sz)
    if (-not $ok) { throw "SetInformationJobObject failed err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
} finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
}

function Quote($s) { '"' + $s + '"' }
$cmdLine = (Quote $NodeExe) + " " + (Quote $ParentScript) + " " + (Quote $JobDir) + " " + (Quote $DummyCli) + " " + (Quote $CoreModule) + " " + (Quote $MarkerPath)

$si = New-Object JobHarness+STARTUPINFO
$si.cb = [System.Runtime.InteropServices.Marshal]::SizeOf($si)
$piRef = New-Object JobHarness+PROCESS_INFORMATION
$sb = New-Object System.Text.StringBuilder($cmdLine)
$ok = [JobHarness]::CreateProcessW($NodeExe, $sb, [IntPtr]::Zero, [IntPtr]::Zero, $false, [JobHarness]::CREATE_SUSPENDED, [IntPtr]::Zero, $PSScriptRoot, [ref]$si, [ref]$piRef)
if (-not $ok) { throw "CreateProcessW(P, suspended) failed err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

$assignOk = [JobHarness]::AssignProcessToJobObject($hJob, $piRef.hProcess)
if (-not $assignOk) { throw "AssignProcessToJobObject failed err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

[JobHarness]::ResumeThread($piRef.hThread) | Out-Null
[JobHarness]::CloseHandle($piRef.hThread) | Out-Null

Set-Content -Path $ParentPidFile -Value $piRef.dwProcessId -Encoding utf8 -NoNewline
Write-Output "READY pid=$($piRef.dwProcessId) jobFlags=0x$($JobFlags.ToString('X'))"

# Block forever, holding hJob (and hProcess) open. This process gets killed directly by the
# node orchestrator (by its own pid, no /T) to trigger kill-on-close deterministically.
while ($true) { Start-Sleep -Seconds 3600 }
