<#
.SYNOPSIS
  Builds the claude-async container job image and checks it on claunker (docs/container-jobs.md,
  rollout step "Build the image and run the smoke test").

.DESCRIPTION
  1. docker build -t <Image> -f container/Dockerfile container
  2. Runs throwaway containers with the SAME isolation flags container.mjs uses for real jobs
     (--rm, --pull=never, --init, --user 1000:1000, no-new-privileges, cap-drop ALL, cpu/memory/pids
     limits, host-gateway) and checks:
       - git, gh, node, python3, uv, rg, claude run (versions printed)
       - the job user is uid 1000, not root, and cannot gain privileges
       - ~/.claude is not writable (no user settings.json, agents/, commands/ a job could plant)
       - host Ollama answers at http://host.docker.internal:11434/api/tags
       - NETWORK BOUNDARY (section 4b; every probe must actually run, see below):
           * loopback forwarding, MEASURED: a temporary TcpListener on the host's 127.0.0.1:<random>
             is probed through host.docker.internal. Reachable = Docker Desktop forwards to host
             loopback (expected; it is how Ollama is reached), so every loopback service is exposed.
           * host.docker.internal, claunker's own tailnet and LAN IPs (discovered with
             Get-NetIPAddress), and any -ExtraHosts: 7842 (HTTP MCP bridge) and 2375/2376 (Docker
             Engine API) must be CLOSED or, for 7842, answer 401 (token-locked bridge). 7850 (host
             API, bearer-token gated) reachable is a WARN.
           * -LanTargets host:port pairs: reachable is a WARN (phase 1 can reach the LAN/tailnet).
         A probe that did not run (container failed, a result missing or duplicated, a name that did
         not resolve) is a FAIL, never a pass.
       - no Docker socket is visible, no host path is bind-mounted except CLAUDE.md and hooks
         (read-only), and /workspace is container-local and empty
       - with -EnvFile: the secrets reach the container as env vars (only NAMES and lengths are
         printed), gh authenticates as the bot (prints the login only), git over https works through
         the image's credential helper, the entrypoint clones -Repo, and (-RunClaude) claude makes one
         tiny model call the way a real job does.
  Never prints a secret value. Exits 0 when every check passes (WARNs allowed), 1 otherwise.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File container\smoke-test.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File container\smoke-test.ps1 -SkipBuild `
    -EnvFile "$env:USERPROFILE\.claude-async-secrets\container.env" -RunClaude
  ... -LanTargets "192.168.1.10:8123","100.101.102.103:7850" -ExtraHosts "claunker.tailnet-name.ts.net"
#>
param(
  [string]$Image = "claude-async-job:local",
  [string]$EnvFile = "",
  [switch]$RunClaude,
  [switch]$SkipBuild,
  [string]$Docker = "docker",
  [string]$Repo = "icey2488/container-job-scratch",
  [int[]]$ForbiddenPorts = @(7842, 2375, 2376),
  [int[]]$WarnPorts = @(7850),
  [string[]]$ExtraHosts = @(),
  [string[]]$LanTargets = @()
)
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$failures = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]
function Pass($m) { Write-Host "PASS  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "WARN  $m" -ForegroundColor Yellow; $warnings.Add($m) }
function Fail($m) { Write-Host "FAIL  $m" -ForegroundColor Red; $failures.Add($m) }

# The same isolation flags as container.mjs buildDockerRunArgv() (minus the job's env and command).
$base = @("run", "--rm", "--pull=never", "--init", "--user", "1000:1000", "--security-opt", "no-new-privileges",
          "--cap-drop", "ALL", "--cpus", "2", "--memory", "2g", "--memory-swap", "2g", "--pids-limit", "256",
          "--network", "bridge", "--add-host", "host.docker.internal:host-gateway")
$roMounts = @("--mount", "type=bind,source=$((Join-Path $repoRoot 'container\CLAUDE.md') -replace '\\','/'),target=/home/agent/.claude/CLAUDE.md,readonly",
              "--mount", "type=bind,source=$((Join-Path $repoRoot 'hooks') -replace '\\','/'),target=/opt/claude-async/hooks,readonly")

# Windows PowerShell 5.1 does not escape embedded double quotes when it passes arguments to a
# native program, so a bash script is never passed as-is: it travels base64-encoded (no quotes,
# no CR) and is decoded inside the container.
function Invoke-InContainer([string[]]$extra, [string]$body) {
  $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($body -replace "`r", "")))
  $dockerArgs = $base + $extra + @($script:imageRef, "bash", "-c", "echo $b64 | base64 -d | bash")
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $out = & $Docker @dockerArgs 2>&1 } finally { $ErrorActionPreference = $prev }
  return @{ code = $LASTEXITCODE; out = ($out | Out-String) }
}

# Runs container/probe.sh in a container over the given targets (objects with label/host/port) and
# returns a hashtable "label|host|port" -> OPEN/CLOSED/DNSFAIL, or $null (with a FAIL recorded) when
# the probe did not complete: nonzero exit, missing trailer, a missing/duplicate/unknown result line.
function Invoke-Probe($targets, [string]$what) {
  $probe = (Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "probe.sh")) -replace "`r", ""
  $lines = ($targets | ForEach-Object { "$($_.label) $($_.host) $($_.port)" }) -join "`n"
  $body = "cat > /tmp/probe.sh <<'PROBE_EOF'`n$probe`nPROBE_EOF`nbash /tmp/probe.sh <<'TARGETS_EOF'`n$lines`nTARGETS_EOF`n"
  $r = Invoke-InContainer @() $body
  if ($r.code -ne 0) { Fail "${what}: probe container exited $($r.code) (inconclusive): $($r.out.Trim())"; return $null }
  $results = @{}
  foreach ($m in [regex]::Matches($r.out, "(?m)^RESULT (\S+) (\S+) (\d+) (OPEN|CLOSED|DNSFAIL)\s*$")) {
    $key = "$($m.Groups[1].Value)|$($m.Groups[2].Value)|$($m.Groups[3].Value)"
    if ($results.ContainsKey($key)) { Fail "${what}: duplicate result for $key (inconclusive)"; return $null }
    $results[$key] = $m.Groups[4].Value
  }
  $done = [regex]::Match($r.out, "(?m)^PROBE_DONE (\d+)\s*$")
  if (-not $done.Success -or [int]$done.Groups[1].Value -ne @($targets).Count) {
    Fail "${what}: probe did not report completion for all $(@($targets).Count) targets (inconclusive): $($r.out.Trim())"; return $null
  }
  foreach ($t in $targets) {
    $key = "$($t.label)|$($t.host)|$($t.port)"
    if (-not $results.ContainsKey($key)) { Fail "${what}: no result for $key (inconclusive)"; return $null }
  }
  if ($results.Count -ne @($targets).Count) { Fail "${what}: unexpected extra results (inconclusive)"; return $null }
  return $results
}
function T([string]$label, [string]$h, [int]$p) { [pscustomobject]@{ label = $label; host = $h; port = $p } }

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
# Like a real job: run by the immutable image ID, never by tag, never pulling.
$script:imageRef = ((& $Docker image inspect --format "{{.Id}}" $Image) 2>$null | Out-String).Trim()
if ($script:imageRef -notmatch '^sha256:[0-9a-f]{64}$') { Fail "image $Image not found locally"; exit 1 }
Write-Host "image id: $($script:imageRef)"

# --- 2. Tools --------------------------------------------------------------------------------
$r = Invoke-InContainer @() 'set -e; git --version; gh --version | head -1; node --version; python3 --version; uv --version; rg --version | head -1; claude --version'
if ($r.code -eq 0) { Pass "tools run:`n$($r.out.Trim())" } else { Fail "tools: $($r.out)" }

# --- 3. Non-root, no privilege gain, ~/.claude unwritable ----------------------------------
$r = Invoke-InContainer @() 'id -u; grep -E "^(NoNewPrivs|CapEff):" /proc/self/status; (sudo -n true 2>/dev/null && echo SUDO_OK) || echo NO_SUDO; touch /home/agent/.claude/settings.json 2>/dev/null && echo SETTINGS_WRITABLE || echo SETTINGS_REFUSED; mkdir /home/agent/.claude/agents 2>/dev/null && echo AGENTS_WRITABLE || echo AGENTS_REFUSED'
if ($r.code -eq 0 -and $r.out -match "(?m)^1000\s*$" -and $r.out -match "NoNewPrivs:\s+1" -and $r.out -match "CapEff:\s+0+\s" -and $r.out -match "NO_SUDO" -and
    $r.out -match "SETTINGS_REFUSED" -and $r.out -match "AGENTS_REFUSED") {
  Pass "uid 1000, NoNewPrivs=1, no effective capabilities, no sudo, ~/.claude not writable"
} else { Fail "privileges / ~/.claude: $($r.out)" }

# --- 4. Host Ollama --------------------------------------------------------------------------
$r = Invoke-InContainer @() 'curl -fsS --max-time 10 http://host.docker.internal:11434/api/tags | head -c 400'
if ($r.code -eq 0 -and $r.out -match '"models"') {
  if ($r.out -match "qwen2\.5-coder:7b") { Pass "host Ollama reachable, qwen2.5-coder:7b listed" }
  else { Fail "host Ollama reachable but qwen2.5-coder:7b is not in /api/tags (pull it on the host)" }
} else {
  Fail "host Ollama NOT reachable at host.docker.internal:11434 (is Ollama listening on 0.0.0.0 / allowed through the firewall for the WSL/Docker vEthernet?): $($r.out)"
}

# --- 4b. Network boundary --------------------------------------------------------------------
# (1) Measure loopback forwarding directly, independent of which services happen to be running.
$listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
try {
  $canary = $listener.LocalEndpoint.Port
  $res = Invoke-Probe @(T "loopback-canary" "host.docker.internal" $canary) "loopback canary"
  if ($res) {
    $v = $res["loopback-canary|host.docker.internal|$canary"]
    if ($v -eq "OPEN") { Pass "measured: host.docker.internal reaches the host's 127.0.0.1 (port $canary). Every loopback service is reachable from a job." }
    elseif ($v -eq "CLOSED") { Pass "measured: host.docker.internal does NOT reach the host's 127.0.0.1 (canary port $canary closed)" }
    else { Fail "loopback canary: host.docker.internal did not resolve (inconclusive)" }
  }
} finally { $listener.Stop() }

# (2) Forbidden and warn ports on every address of this host a container might use.
$hostAddrs = New-Object System.Collections.Generic.List[object]
$hostAddrs.Add([pscustomobject]@{ label = "gateway"; host = "host.docker.internal" })
try {
  foreach ($a in (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop | Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" })) {
    $o = [int]($a.IPAddress.Split(".")[0]); $o2 = [int]($a.IPAddress.Split(".")[1])
    $kind = if ($o -eq 100 -and ($o2 -band 0xC0) -eq 0x40) { "tailnet" } else { "lan" }
    $hostAddrs.Add([pscustomobject]@{ label = "$kind-$($a.InterfaceAlias -replace '[^A-Za-z0-9]', '')"; host = $a.IPAddress })
  }
} catch { Fail "could not list this host's IPv4 addresses with Get-NetIPAddress ($($_.Exception.Message)); pass them with -ExtraHosts" }
foreach ($h in $ExtraHosts) { $hostAddrs.Add([pscustomobject]@{ label = "extra"; host = $h }) }
$targets = @()
foreach ($h in $hostAddrs) { foreach ($p in ($ForbiddenPorts + $WarnPorts)) { $targets += T $h.label $h.host $p } }
$res = Invoke-Probe $targets "host ports"
if ($res) {
  foreach ($t in $targets) {
    $v = $res["$($t.label)|$($t.host)|$($t.port)"]
    $where = "$($t.host):$($t.port) ($($t.label))"
    if ($v -eq "DNSFAIL") { Fail "$where did not resolve (inconclusive)"; continue }
    if ($WarnPorts -contains $t.port) {
      if ($v -eq "OPEN") { Warn "$where is reachable from a job container (host API; bearer-token gated)" } else { Pass "$where not reachable" }
      continue
    }
    if ($v -eq "CLOSED") { Pass "$where not reachable"; continue }
    if ($t.port -eq 7842) {
      # Reachable is acceptable only if the bridge is token-locked: an unauthenticated MCP request must get 401.
      $c = Invoke-InContainer @() "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{""jsonrpc"":""2.0"",""id"":1,""method"":""tools/list""}' http://$($t.host):7842/mcp"
      if ($c.code -eq 0 -and $c.out.Trim() -eq "401") { Pass "$where is reachable but token-locked (401 without a token)" }
      else { Fail "$where is reachable and did NOT answer 401 (got '$($c.out.Trim())'): an unauthenticated MCP bridge lets a job start host jobs. Run 'node claude-async-http.mjs --new-token' and restart the bridge (or stop it)." }
      continue
    }
    Fail "$where is reachable from a job container. Do not enable container mode until this is closed (docs/container-jobs.md 'Host loopback services')."
  }
}

# (3) LAN / tailnet services the operator wants to know about: reachable is a WARN (phase 1 has
# open egress; phase 2's internal network removes these routes).
if ($LanTargets.Count -gt 0) {
  $lan = @()
  foreach ($lt in $LanTargets) {
    if ($lt -notmatch '^([A-Za-z0-9.:-]+):(\d{1,5})$') { Fail "-LanTargets entry '$lt' is not host:port"; continue }
    $lan += T "lan-target" $Matches[1] ([int]$Matches[2])
  }
  if ($lan.Count -gt 0) {
    $res = Invoke-Probe $lan "LAN targets"
    if ($res) {
      foreach ($t in $lan) {
        $v = $res["$($t.label)|$($t.host)|$($t.port)"]
        if ($v -eq "OPEN") { Warn "$($t.host):$($t.port) is reachable from a job container (phase 1 open egress)" }
        elseif ($v -eq "CLOSED") { Pass "$($t.host):$($t.port) not reachable" }
        else { Fail "$($t.host):$($t.port) did not resolve (inconclusive)" }
      }
    }
  }
}

# --- 5. No socket, no host paths, container-local workspace ---------------------------------
$check = @'
bad=0
for p in /var/run/docker.sock /run/docker.sock /.docker /root/.docker /home/agent/.ssh /home/agent/.config/gh /home/agent/.claude/.credentials.json; do
  if [ -e "$p" ]; then echo "VISIBLE $p"; bad=1; fi
done
if grep -Ei "docker\.sock|\.ssh|\.claunker|\.claude-async|GitCredentialManager|Microsoft/Credentials|\.git-credentials|AppData" /proc/self/mountinfo; then bad=1; fi
targets=$(awk '$5 ~ /^\/(workspace|home\/agent\/\.claude\/CLAUDE\.md|opt\/claude-async\/hooks)$/ {print $5}' /proc/self/mountinfo | sort | tr '\n' ' ')
echo "BIND_TARGETS $targets"
case "$targets" in *"/workspace"*) echo "WORKSPACE_IS_A_MOUNT"; bad=1 ;; esac
[ -z "$(ls -A /workspace)" ] || { echo "WORKSPACE_NOT_EMPTY"; bad=1; }
touch /home/agent/.claude/CLAUDE.md 2>/dev/null && { echo "CLAUDE_MD_WRITABLE"; bad=1; }
touch /opt/claude-async/hooks/x 2>/dev/null && { echo "HOOKS_WRITABLE"; bad=1; }
touch /workspace/.smoke-write && rm /workspace/.smoke-write || { echo "WORKSPACE_NOT_WRITABLE"; bad=1; }
env | cut -d= -f1 | grep -E "TOKEN|SECRET|PASSWORD|API_KEY" && bad=1
exit $bad
'@
$r = Invoke-InContainer $roMounts $check
if ($r.code -eq 0) { Pass "no Docker socket, no host credential paths, only CLAUDE.md/hooks mounted (read-only), /workspace container-local and empty, no secrets without -EnvFile`n$($r.out.Trim())" }
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
    $r = Invoke-InContainer $envArgs "git ls-remote https://github.com/$Repo HEAD | cut -c1-12"
    if ($r.code -eq 0 -and $r.out.Trim()) { Pass "git over https uses the bot token through the image's credential helper ($Repo)" } else { Fail "git credential helper / repo access: $($r.out)" }
    $r = Invoke-InContainer $envArgs "/usr/local/bin/claude-async-job-entry $Repo '' -- bash -c 'git log -1 --format=%h; git remote get-url origin; ! grep -rq x-access-token .git/config'"
    if ($r.code -eq 0) { Pass "the entrypoint clones $Repo into /workspace; no token in .git/config:`n$($r.out.Trim())" } else { Fail "entrypoint clone (exit $($r.code)): $($r.out)" }
    if ($RunClaude) {
      $r = Invoke-InContainer ($envArgs + $roMounts) "/usr/local/bin/claude-async-job-entry $Repo '' -- claude -p --dangerously-skip-permissions --setting-sources user --strict-mcp-config --mcp-config '{""mcpServers"":{}}' --model=claude-sonnet-5 --effort low -- 'Reply with exactly the word PONG and nothing else.'"
      if ($r.code -eq 0 -and $r.out -match "PONG") { Pass "claude -p ran headless on the subscription token, in the clone, like a real job" } else { Fail "claude headless call: $($r.out)" }
    }
  }
}

Write-Host ""
if ($warnings.Count -gt 0) { Write-Host "$($warnings.Count) warning(s): review them (phase 1 accepts LAN/tailnet reachability; see docs/container-jobs.md)." -ForegroundColor Yellow }
if ($failures.Count -eq 0) { Write-Host "SMOKE TEST PASS ($Image $($script:imageRef))" -ForegroundColor Green; exit 0 }
Write-Host "SMOKE TEST FAIL: $($failures.Count) check(s) failed" -ForegroundColor Red
exit 1
