<#
.SYNOPSIS
  Compiles test/dummy-claude.exe: a stand-in for the real `claude` CLI used by
  test/detach-survival.mjs. Ignores all argv (startJob() always passes -p/--model/etc, which
  don't matter here) and just sleeps for $env:DUMMY_SLEEP_SECONDS (default 20) so there's
  something for job-runner.mjs to be "running" and heartbeating about.

  A real .exe is required here, not a .cmd/.bat: job-runner.mjs spawns `command` directly via
  node's child_process.spawn with no shell, which fails with EINVAL against a .cmd/.bat file
  (Windows can't CreateProcess a batch file directly) -- discovered while building this test.
#>
param([Parameter(Mandatory=$true)][string]$OutputPath)

if (Test-Path $OutputPath) { exit 0 }

$code = @'
using System;
using System.Threading;
class DummyClaude {
    static void Main(string[] args) {
        int seconds = 20;
        var env = Environment.GetEnvironmentVariable("DUMMY_SLEEP_SECONDS");
        if (!string.IsNullOrEmpty(env)) int.TryParse(env, out seconds);
        Thread.Sleep(seconds * 1000);
    }
}
'@

Add-Type -TypeDefinition $code -OutputType ConsoleApplication -OutputAssembly $OutputPath -ErrorAction Stop
