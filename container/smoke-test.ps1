<#
.SYNOPSIS
  Builds the claude-async container job image and checks it on claunker (docs/container-jobs.md,
  rollout step "Run the smoke test").

.DESCRIPTION
  1. docker build -t <Image> -f container/Dockerfile container
  2. Runs throwaway containers with the SAME isolation flags container.mjs uses for real jobs
     (--rm, --init, --user 1000:1000, no-new-privileges, cap-drop ALL, cpu/memory/pids limits,
     host-gateway) and checks:
       - git, gh, node, python3, uv, rg, claude all run (versions printed)
       - the job user is uid 1000, not root, and cannot gain privileges
       - host Ollama answers at http://host.docker.internal:11434/api/tags
       - no Docker socket is visible, and none of the host secret/credential paths are mounted
         (it greps the container's own mount table for them)
       - with -EnvFile: the secrets file reaches the container as env vars (only their NAMES and
         lengths are printed), gh authenticates as the bot (prints the login only), and claude
         can make one tiny model call (-RunClaude).
  Never prints a secret value. Exits 0 when every check passes, 1 otherwise.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File container\smoke-test.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File container\smoke-test.ps1 -EnvFile "$env:USERPROFILE\.claude-async-secrets\container.env" -RunClaude
#>
param(
  [string]$Image = "claude-async-job:local",
  [string]$EnvFile = "",
  [switch]$RunClaude,
  [switch]$SkipBuild,
  [string]$Docker = "docker"
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$failures = New-Object System.Collections.Generic.List[string]
function Pass($m) { Write-Host "PASS  $m" -ForegroundColor Green }
function Fail($m) { Write-Host "FAIL  $m" -ForegroundColor Red; $failures.Add($m) }

# The same isolation flags as container.mjs buildDockerRunArgv() (minus the job's mounts/env).
$base = @("run", "--rm", "--init", "--user", "1000:1000", "--security-opt", "no-new-privileges",
          "--cap-drop", "ALL", "--cpus", "2", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "256",
          "--network", "bridge", "--add-host", "host.docker.internal:host-gateway")

# Windows PowerShell 5.1 does not escape embedded double quotes when it passes arguments to a
# native program, so a bash script is never passed as-is: it travels base64-encoded (no quotes,
# no CR) and is decoded inside the container.
function Invoke-InContainer([string[]]$extra, [string]$script) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($script -replace "`r", "")))
  $dockerArgs = $base + $extra + @($Image, "bash", "-c", "echo $b64 | base64 -d | bash")
  $out = & $Docker @dockerArgs 2>&1
  return @{ code = $LASTEXITCODE; out = ($out | Out-String) }
}

# --- 0. Docker is up -------------------------------------------------------------------------
& $Docker version --format "{{.Server.Version}}" *> $null
if ($LASTEXITCODE -ne 0) { Write-Host "Docker is not running (start Docker Desktop first)." -ForegroundColor Red; exit 1 }
Pass "docker daemon reachable"

# --- 1. Build --------------------------------------------------------------------------------
if (-not $SkipBuild) {
  & $Docker build -t $Image -f (Join-Path $repoRoot "container\Dockerfile") (Join-Path $repoRoot "container")
  if ($LASTEXITCODE -ne 0) { Fail "docker build"; exit 1 }
  Pass "docker build -t $Image"
}
$digest = (& $Docker image inspect --format "{{.Id}}" $Image) 2>$null
Write-Host "image id: $digest"

# --- 2. Tools --------------------------------------------------------------------------------
$r = Invoke-InContainer @() 'set -e; git --version; gh --version | head -1; node --version; python3 --version; uv --version; rg --version | head -1; claude --version'
if ($r.code -eq 0) { Pass "tools run:`n$($r.out.Trim())" } else { Fail "tools: $($r.out)" }

# --- 3. Non-root, no privilege gain ---------------------------------------------------------
$r = Invoke-InContainer @() 'id -u; grep -E "^(NoNewPrivs|CapEff):" /proc/self/status; (sudo -n true 2>/dev/null && echo SUDO_OK) || echo NO_SUDO'
if ($r.out -match "(?m)^1000\s*$" -and $r.out -match "NoNewPrivs:\s+1" -and $r.out -match "CapEff:\s+0+\s" -and $r.out -match "NO_SUDO") {
  Pass "runs as uid 1000, NoNewPrivs=1, no effective capabilities, no sudo"
} else { Fail "privileges: $($r.out)" }

# --- 4. Host Ollama --------------------------------------------------------------------------
$r = Invoke-InContainer @() 'curl -fsS --max-time 10 http://host.docker.internal:11434/api/tags | head -c 400'
if ($r.code -eq 0 -and $r.out -match '"models"') {
  if ($r.out -match "qwen2\.5-coder:7b") { Pass "host Ollama reachable, qwen2.5-coder:7b listed" }
  else { Fail "host Ollama reachable but qwen2.5-coder:7b is not in /api/tags (pull it on the host)" }
} else {
  Fail "host Ollama NOT reachable at host.docker.internal:11434 (is Ollama listening on 0.0.0.0 / allowed through the firewall for the WSL/Docker vEthernet?): $($r.out)"
}

# --- 5. No socket, no host secrets ----------------------------------------------------------
# The container sees only what is mounted. The job's real mounts are the repo, CLAUDE.md and hooks;
# this check mounts a scratch repo the same way and then looks for anything that should never be there.
$scratch = Join-Path $env:TEMP ("claude-async-smoke-" + [guid]::NewGuid().ToString("N").Substring(0, 8))
New-Item -ItemType Directory -Path $scratch | Out-Null
git -C $scratch init -q 2>$null
$mounts = @("--mount", "type=bind,source=$($scratch -replace '\\','/'),target=/workspace",
            "--mount", "type=bind,source=$((Join-Path $repoRoot 'container\CLAUDE.md') -replace '\\','/'),target=/home/agent/.claude/CLAUDE.md,readonly",
            "--mount", "type=bind,source=$((Join-Path $repoRoot 'hooks') -replace '\\','/'),target=/opt/claude-async/hooks,readonly",
            "--workdir", "/workspace")
$check = @'
bad=0
for p in /var/run/docker.sock /run/docker.sock /.docker /root/.docker /home/agent/.ssh /home/agent/.config/gh /home/agent/.claude/.credentials.json; do
  if [ -e "$p" ]; then echo "VISIBLE $p"; bad=1; fi
done
if grep -Ei "docker\.sock|\.ssh|\.claunker|\.claude-async|GitCredentialManager|Microsoft/Credentials|\.git-credentials|AppData" /proc/self/mountinfo; then bad=1; fi
mounts=$(awk '$5 ~ /^\/(workspace|home\/agent\/\.claude\/CLAUDE\.md|opt\/claude-async\/hooks)$/ {print $5}' /proc/self/mountinfo | sort | tr '\n' ' ')
echo "BIND_TARGETS $mounts"
touch /home/agent/.claude/CLAUDE.md 2>/dev/null && { echo "CLAUDE_MD_WRITABLE"; bad=1; }
touch /opt/claude-async/hooks/x 2>/dev/null && { echo "HOOKS_WRITABLE"; bad=1; }
touch /workspace/.smoke-write && rm /workspace/.smoke-write || { echo "WORKSPACE_NOT_WRITABLE"; bad=1; }
git -C /workspace status --short >/dev/null || { echo "GIT_STATUS_FAILED"; bad=1; }
env | cut -d= -f1 | grep -E "TOKEN|SECRET|PASSWORD|API_KEY" && bad=1
exit $bad
'@
$r = Invoke-InContainer $mounts $check
if ($r.code -eq 0) { Pass "no Docker socket, no host credential paths, CLAUDE.md/hooks read-only, /workspace writable, no secrets without -EnvFile`n$($r.out.Trim())" }
else { Fail "isolation check:`n$($r.out)" }

# --- 6. Secrets file (optional) --------------------------------------------------------------
if ($EnvFile) {
  if (-not (Test-Path -LiteralPath $EnvFile)) { Fail "env file $EnvFile not found" }
  else {
    $envArgs = @("--env-file", $EnvFile)
    $r = Invoke-InContainer $envArgs 'for k in GH_TOKEN CLAUDE_CODE_OAUTH_TOKEN; do v=$(printenv "$k" || true); echo "$k length=${#v}"; done; gh api user --jq .login'
    if ($r.code -eq 0 -and $r.out -match "GH_TOKEN length=[1-9]" -and $r.out -match "CLAUDE_CODE_OAUTH_TOKEN length=[1-9]") {
      $login = ($r.out.Trim() -split "`r?`n")[-1]
      Pass "secrets reach the container as env (names/lengths only shown); gh authenticated as: $login"
    } else { Fail "secrets/gh auth: $($r.out)" }
    $r = Invoke-InContainer $envArgs 'gh auth setup-git >/dev/null && git ls-remote https://github.com/icey2488/claude-async HEAD | cut -c1-12'
    if ($r.code -eq 0) { Pass "git over https uses the bot token (gh auth setup-git)" } else { Fail "git credential helper: $($r.out)" }
    if ($RunClaude) {
      $r = Invoke-InContainer ($envArgs + $mounts) 'claude -p --dangerously-skip-permissions --strict-mcp-config --mcp-config ''{"mcpServers":{}}'' --model=claude-sonnet-5 --effort low -- "Reply with exactly the word PONG and nothing else."'
      if ($r.code -eq 0 -and $r.out -match "PONG") { Pass "claude -p ran headless on the subscription token" } else { Fail "claude headless call: $($r.out)" }
    }
  }
}

Remove-Item -Recurse -Force $scratch -ErrorAction SilentlyContinue
if ($failures.Count -eq 0) { Write-Host "`nSMOKE TEST PASS ($Image $digest)" -ForegroundColor Green; exit 0 }
Write-Host "`nSMOKE TEST FAIL: $($failures.Count) check(s) failed" -ForegroundColor Red
exit 1
