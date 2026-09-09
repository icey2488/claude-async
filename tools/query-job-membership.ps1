<#
.SYNOPSIS
  Reports whether a process is a member of a Windows Job Object, and (self-queries only) that
  job's limit flags -- built for the 2026-09-09 runner-termination investigation, so job-core.mjs
  and job-runner.mjs can log hard evidence of job membership instead of inferring it from
  breakaway exit codes alone.

.DESCRIPTION
  Two modes:
    -TargetPid <pid>   One-shot: query the given pid, print one line of JSON, exit. Used by
                        job-core.mjs right after a win32 launch to check the freshly-spawned
                        runner's pid (a foreign pid from this script's point of view).
    -Server             Persistent: Add-Type compiles once, then this process reads pids (one per
                        line) from stdin forever, writing one line of JSON per line read. Lets a
                        caller poll cheaply on every heartbeat without re-paying the Add-Type JIT
                        cost (a fresh powershell.exe + compile) on every single call.

  Foreign-pid queries (TargetPid different from this script's own $PID) can only answer `inJob`,
  via IsProcessInJob on an OpenProcess handle. Windows has no documented API to fetch a job's
  LimitFlags without a handle to that specific job object, and you cannot obtain a handle to a job
  you did not create or open by name -- so limitFlags/killOnClose/silentBreakawayOk/breakawayOk
  come back null for a foreign pid. Self-queries (TargetPid omitted, or equal to $PID) additionally
  call QueryInformationJobObject with a NULL job handle, which is documented to return information
  for the CALLING process's own job -- that is the only case where those four fields are populated.

  -Server mode always answers "what job is this powershell.exe helper in", regardless of which pid
  was read from stdin -- there is no way to answer for an arbitrary foreign pid without a job
  handle (see above). Callers rely on Windows' automatic job nesting instead: a plain child process
  (spawned without a breakaway flag) lands in the same job as its parent, so a helper spawned by
  job-runner.mjs without breakaway is nested into job-runner.mjs's own job and reports on it. The
  pid read from stdin is echoed back in the response as `queriedForPid` for traceability only.
#>
param(
  [int]$TargetPid = $PID,
  [switch]$Server
)

$code = @'
using System;
using System.Runtime.InteropServices;

public static class JobMembership {
    public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    public const int JobObjectExtendedLimitInformation = 9;
    public const uint JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0800;
    public const uint JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x1000;
    public const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

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

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, int dwProcessId);

    [DllImport("kernel32.dll")]
    public static extern IntPtr GetCurrentProcess();

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsProcessInJob(IntPtr ProcessHandle, IntPtr JobHandle, out bool Result);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool QueryInformationJobObject(IntPtr hJob, int JobObjectInfoClass, IntPtr lpJobObjectInfo, uint cbJobObjectInfoLength, IntPtr lpReturnLength);
}
'@
Add-Type -TypeDefinition $code -ErrorAction Stop

function Get-SelfJobInfo {
    # Reflects the CALLING (this powershell.exe) process's own job -- see header for why -Server
    # mode always uses this regardless of which pid it was asked about. IsProcessInJob requires a
    # real handle (GetCurrentProcess()'s pseudo-handle), NOT IntPtr.Zero -- IntPtr.Zero is only
    # valid for the second (JobHandle) argument, where it means "any job".
    $result = $false
    $ok = [JobMembership]::IsProcessInJob([JobMembership]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$result)
    if (-not $ok) {
        return @{ inJob = $null; limitFlags = $null; killOnClose = $null; silentBreakawayOk = $null; breakawayOk = $null;
                  error = "IsProcessInJob failed err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
    }
    if (-not $result) {
        return @{ inJob = $false; limitFlags = $null; killOnClose = $null; silentBreakawayOk = $null; breakawayOk = $null }
    }

    $sz = [System.Runtime.InteropServices.Marshal]::SizeOf([type][JobMembership+JOBOBJECT_EXTENDED_LIMIT_INFORMATION])
    $buf = [System.Runtime.InteropServices.Marshal]::AllocHGlobal($sz)
    try {
        $qok = [JobMembership]::QueryInformationJobObject([IntPtr]::Zero, [JobMembership]::JobObjectExtendedLimitInformation, $buf, $sz, [IntPtr]::Zero)
        if (-not $qok) {
            return @{ inJob = $true; limitFlags = $null; killOnClose = $null; silentBreakawayOk = $null; breakawayOk = $null;
                      error = "QueryInformationJobObject failed err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
        }
        $info = [System.Runtime.InteropServices.Marshal]::PtrToStructure($buf, [type][JobMembership+JOBOBJECT_EXTENDED_LIMIT_INFORMATION])
        $flags = [uint32]$info.BasicLimitInformation.LimitFlags
        return @{
            inJob = $true
            limitFlags = "0x{0:X}" -f $flags
            killOnClose = (($flags -band [JobMembership]::JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) -ne 0)
            silentBreakawayOk = (($flags -band [JobMembership]::JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK) -ne 0)
            breakawayOk = (($flags -band [JobMembership]::JOB_OBJECT_LIMIT_BREAKAWAY_OK) -ne 0)
        }
    } finally {
        [System.Runtime.InteropServices.Marshal]::FreeHGlobal($buf)
    }
}

function Get-ForeignJobInfo([int]$queryPid) {
    $h = [JobMembership]::OpenProcess([JobMembership]::PROCESS_QUERY_LIMITED_INFORMATION, $false, $queryPid)
    if ($h -eq [IntPtr]::Zero) {
        return @{ inJob = $null; limitFlags = $null; killOnClose = $null; silentBreakawayOk = $null; breakawayOk = $null;
                  error = "OpenProcess failed err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
    }
    try {
        $result = $false
        $ok = [JobMembership]::IsProcessInJob($h, [IntPtr]::Zero, [ref]$result)
        if (-not $ok) {
            return @{ inJob = $null; limitFlags = $null; killOnClose = $null; silentBreakawayOk = $null; breakawayOk = $null;
                      error = "IsProcessInJob failed err=$([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
        }
        # Can't get LimitFlags for a foreign job -- see header.
        return @{ inJob = $result; limitFlags = $null; killOnClose = $null; silentBreakawayOk = $null; breakawayOk = $null }
    } finally {
        [JobMembership]::CloseHandle($h) | Out-Null
    }
}

function Emit([int]$reportPid, [bool]$isSelf, [hashtable]$info) {
    $obj = [ordered]@{
        queriedForPid = $reportPid
        selfQuery = $isSelf
        inJob = $info.inJob
        limitFlags = $info.limitFlags
        killOnClose = $info.killOnClose
        silentBreakawayOk = $info.silentBreakawayOk
        breakawayOk = $info.breakawayOk
    }
    if ($info.ContainsKey("error")) { $obj["error"] = $info.error }
    Write-Output ($obj | ConvertTo-Json -Compress)
}

if ($Server) {
    # $PID never changes across requests (one process for this helper's whole lifetime) -- every
    # response is a self-query, whatever pid the caller happened to send (see header).
    while ($true) {
        $line = [Console]::In.ReadLine()
        if ($null -eq $line) { break }  # stdin closed -- caller is done with us
        $line = $line.Trim()
        if ($line -eq "") { continue }
        $reqPid = 0
        [void][int]::TryParse($line, [ref]$reqPid)
        Emit $reqPid $true (Get-SelfJobInfo)
        [Console]::Out.Flush()
    }
} else {
    $isSelf = ($TargetPid -eq $PID)
    $info = if ($isSelf) { Get-SelfJobInfo } else { Get-ForeignJobInfo $TargetPid }
    Emit $TargetPid $isSelf $info
}
