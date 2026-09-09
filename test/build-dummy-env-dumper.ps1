<#
.SYNOPSIS
  Compiles test/dummy-env-dumper.exe: a stand-in for the real `claude` CLI used by
  test/env-integrity.mjs. Ignores all argv (startJob() always passes -p/--model/etc, which don't
  matter here) and instead writes its own environment block to the path named by the
  ENV_DUMP_OUTPUT_PATH environment variable, one NAME=VALUE per line, sorted by name.

  A real .exe is required here, not a .cmd/.bat/.mjs: job-runner.mjs spawns `command` directly via
  node's child_process.spawn with no shell, which fails with EINVAL against a script file (see
  test/build-dummy-claude.ps1's identical note).
#>
param([Parameter(Mandatory=$true)][string]$OutputPath)

if (Test-Path $OutputPath) { exit 0 }

$code = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

class DummyEnvDumper {
    static void Main(string[] args) {
        string outPath = Environment.GetEnvironmentVariable("ENV_DUMP_OUTPUT_PATH");
        if (string.IsNullOrEmpty(outPath)) return;
        var vars = Environment.GetEnvironmentVariables();
        var lines = new List<string>();
        foreach (System.Collections.DictionaryEntry e in vars) {
            lines.Add(e.Key + "=" + e.Value);
        }
        lines.Sort(StringComparer.Ordinal);
        File.WriteAllLines(outPath, lines);
    }
}
'@

Add-Type -TypeDefinition $code -OutputType ConsoleApplication -OutputAssembly $OutputPath -ErrorAction Stop
