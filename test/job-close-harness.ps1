<#
.SYNOPSIS
  Test harness for test/survival.mjs scenario (c): creates a kill-on-close Job Object, assigns
  ITSELF to it, spawns the "parent" node process (P) as an ordinary child (so P nests into the
  same job automatically -- no suspend/assign/resume dance needed, unlike
  test/job-object-harness.ps1, because this process is already a job member before P is created),
  waits for P to finish calling startJob() and for the spawned runner's heartbeat to appear, then
  explicitly CloseHandle()s its own (and the job's only) handle to the job.

.DESCRIPTION
  Scenario (b) (test/job-object-harness.ps1) proves survival when an EXTERNAL process holding the
  job dies (taskkill by pid, no /T). Scenario (c) proves the same thing from the opposite
  direction: the process that is ITSELF inside the job, and that made the startJob() call (via its
  child P), cooperatively closes its own last handle to that job. Per Windows job semantics,
  closing the last handle to a job with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE set terminates every
  process still a member of that job -- including this script's own PowerShell process and P --
  synchronously, inside the CloseHandle call. Whatever is still alive 10s after this script's own
  pid disappears is what escaped the job (the runner, if breakaway/Task-Scheduler ancestry worked)
  versus what didn't.
#>
param(
  [Parameter(Mandatory=$true)][string]$NodeExe,
  [Parameter(Mandatory=$true)][string]$ParentScript,
  [Parameter(Mandatory=$true)][string]$JobDir,
  [Parameter(Mandatory=$true)][string]$DummyCli,
  [Parameter(Mandatory=$true)][string]$CoreModule,
  [Parameter(Mandatory=$true)][string]$MarkerPath,
  [Parameter(Mandatory=$true)][string]$ParentPidFile,
  [Parameter(Mandatory=$true)][string]$HeartbeatPath,
  [uint32]$JobFlags = 0x2800  # KILL_ON_JOB_CLOSE (0x2000) | BREAKAWAY_OK (0x0800), no SILENT
)

$code = @'
using System;
using System.Runtime.InteropServices;

public static class JobCloseHarness {
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

    public const int JobObjectExtendedLimitInformation = 9;

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr CreateJobObjectW(IntPtr a, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetInformationJobObject(IntPtr hJob, int cls, IntPtr info, uint len);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);
}
'@

Add-Type -TypeDefinition $code -ErrorAction Stop

$hJob = [JobCloseHarness]::CreateJobObjectW([IntPtr]::Zero, $null)
if ($hJob -eq [IntPtr]::Zero) { throw "CreateJobObjectW failed err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

$sz = [System.Runtime.InteropServices.Marshal]::SizeOf([type][JobCloseHarness+JOBOBJECT_EXTENDED_LIMIT_INFORMATION])
$buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($sz)
try {
    for ($i = 0; $i -lt $sz; $i++) { [System.Runtime.InteropServices.Marshal]::WriteByte($buf, $i, 0) }
    $basic = New-Object JobCloseHarness+JOBOBJECT_BASIC_LIMIT_INFORMATION
    $basic.LimitFlags = $JobFlags
    $info = New-Object JobCloseHarness+JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    $info.BasicLimitInformation = $basic
    [System.Runtime.InteropServices.Marshal]::StructureToPtr($info, $buf, $false)
    $ok = [JobCloseHarness]::SetInformationJobObject($hJob, [JobCloseHarness]::JobObjectExtendedLimitInformation, $buf, $sz)
    if (-not $ok) { throw "SetInformationJobObject failed err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
} finally {
    [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
}

# Assign OURSELVES before spawning P, so P nests into the same job automatically on creation --
# no suspend/resume dance needed (unlike job-object-harness.ps1, which assigns a *different*
# process and must avoid a race where it runs before being assigned).
$assignOk = [JobCloseHarness]::AssignProcessToJobObject($hJob, [JobCloseHarness]::GetCurrentProcess())
if (-not $assignOk) { throw "AssignProcessToJobObject(self) failed err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }

$proc = Start-Process -FilePath $NodeExe -ArgumentList @($ParentScript, $JobDir, $DummyCli, $CoreModule, $MarkerPath) `
    -WindowStyle Hidden -PassThru
Set-Content -Path $ParentPidFile -Value $proc.Id -Encoding utf8 -NoNewline
Write-Output "READY pid=$($proc.Id) jobFlags=0x$($JobFlags.ToString('X'))"

$deadline = (Get-Date).AddSeconds(20)
while (-not (Test-Path $MarkerPath) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
if (-not (Test-Path $MarkerPath)) { Write-Output "TIMEOUT waiting for marker"; exit 1 }

$deadline = (Get-Date).AddSeconds(15)
while (-not (Test-Path $HeartbeatPath) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200 }
if (-not (Test-Path $HeartbeatPath)) { Write-Output "TIMEOUT waiting for heartbeat"; exit 1 }

Write-Output "CLOSING"
# If KILL_ON_JOB_CLOSE took hold of this process too (i.e. nothing escaped), this call never
# returns -- this process is terminated as part of the same syscall. That's expected and is
# exactly what scenario (c) is testing for on the *pre*-fix code path.
[JobCloseHarness]::CloseHandle($hJob) | Out-Null
Write-Output "CLOSED (survived own job close -- unexpected unless this process itself broke away)"
