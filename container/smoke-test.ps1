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
       - ~/.claude is not writable and not replaceable (root-owned HOME): no user settings.json,
         agents/, commands/ a job could plant or swap in
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
         (read-only), /workspace is container-local and empty, the image's git credential helper and
         gh wrapper are in place, and no GH_TOKEN exists anywhere without the creds mount
       - TOKEN FILE PROPAGATION (section 5b, always): a host directory bind-mounted (read-only) into a
         running container gets two same-length updates of its file, each measured on its own: an
         IN-PLACE rewrite (the runner's fallback; also shows whether WSL2's file sharing notices a
         content change that keeps st_size) and a RENAME of a temp file over it inside the mounted
         directory (how the runner publishes every token generation since review round 3). The
         container must see the renamed file within 5 s, or the check FAILS; an in-place rewrite that
         does not propagate is a WARN (the fallback would not reach jobs). Both are reported.
       - with -EnvFile and the GitHub App settings (-AppId/-AppKeyFile, or the CLAUDE_ASYNC_GITHUB_APP_ID /
         _KEY_FILE environment variables): CLAUDE_CODE_OAUTH_TOKEN reaches the container as env (only
         the NAME and length are printed), tools/mint-app-token.mjs mints an installation token for
         -Repo into a temporary creds dir (the preflight job-core runs: key file, installation, App
         identity), the container reads it through the read-only creds mount while `env` shows no
         GH_TOKEN, gh authenticates as the App (prints the repo's full name only), git over https works
         through the image's credential helper, the entrypoint clones -Repo with no token in
         .git/config, and (-RunClaude) claude makes one tiny model call the way a real job does.
  Never prints a secret value. Exits 0 when every check passes (WARNs allowed), 1 otherwise.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File container\smoke-test.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File container\smoke-test.ps1 -SkipBuild `
    -EnvFile "$env:USERPROFILE\.claude-async-secrets\container.env" `
    -AppId 123456 -AppKeyFile "$env:USERPROFILE\.claude-async-secrets\github-app.pem" -RunClaude
  ... -LanTargets "192.168.1.10:8123","100.101.102.103:7850" -ExtraHosts "claunker.tailnet-name.ts.net"
#>
param(
  [string]$Image = "claude-async-job:local",
  [string]$EnvFile = "",
  [string]$AppId = $env:CLAUDE_ASYNC_GITHUB_APP_ID,
  [string]$AppKeyFile = $env:CLAUDE_ASYNC_GITHUB_APP_KEY_FILE,
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

# --- 3. Non-root, no privilege gain, ~/.claude unwritable AND not replaceable ----------------
# Direct writes into ~/.claude, and (round 2) a rename of ~/.claude or a new entry under $HOME: both
# need write permission on the PARENT, which is root-owned in the image. A rename that merely fails
# with EXDEV (overlayfs lower-layer directory) would be a storage-driver accident; the check below
# requires the parent itself to be root-owned, so the refusal is a permission.
$r = Invoke-InContainer @() 'id -u; grep -E "^(NoNewPrivs|CapEff):" /proc/self/status; (sudo -n true 2>/dev/null && echo SUDO_OK) || echo NO_SUDO; touch /home/agent/.claude/settings.json 2>/dev/null && echo SETTINGS_WRITABLE || echo SETTINGS_REFUSED; mkdir /home/agent/.claude/agents 2>/dev/null && echo AGENTS_WRITABLE || echo AGENTS_REFUSED; python3 -c "import os; os.rename(\"/home/agent/.claude\", \"/home/agent/.claude.old\")" 2>/dev/null && echo RENAME_OK || echo RENAME_REFUSED; mkdir /home/agent/.smoke-new 2>/dev/null && echo HOME_WRITABLE || echo HOME_REFUSED; stat -c "HOME_OWNER=%U" /home/agent; git config --global smoke.ok 1 2>/dev/null && echo GITCONFIG_OK || echo GITCONFIG_REFUSED'
if ($r.code -eq 0 -and $r.out -match "(?m)^1000\s*$" -and $r.out -match "NoNewPrivs:\s+1" -and $r.out -match "CapEff:\s+0+\s" -and $r.out -match "NO_SUDO" -and
    $r.out -match "SETTINGS_REFUSED" -and $r.out -match "AGENTS_REFUSED" -and $r.out -match "RENAME_REFUSED" -and $r.out -match "HOME_REFUSED" -and
    $r.out -match "HOME_OWNER=root" -and $r.out -match "GITCONFIG_OK") {
  Pass "uid 1000, NoNewPrivs=1, no effective capabilities, no sudo, ~/.claude not writable and not replaceable (root-owned HOME), git global config still writable"
} else { Fail "privileges / ~/.claude / HOME: $($r.out)" }

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
    if ($t.port -eq 7842 -and $v -eq "CLOSED") {
      # Nothing listening now, but the bridge may be started later (pm2, a reboot): it then enforces
      # whatever http.json holds, so the hash must be there even while the port is closed.
      $cfgDir = if ($env:CLAUDE_ASYNC_CONFIG_DIR) { $env:CLAUDE_ASYNC_CONFIG_DIR } else { Join-Path $env:USERPROFILE ".claude-async" }
      $httpJson = Join-Path $cfgDir "http.json"
      $hash = $null
      try { $hash = (Get-Content -Raw -ErrorAction Stop $httpJson | ConvertFrom-Json).tokenSha256 } catch {}
      if ($hash -and $hash -match '^[0-9a-fA-F]{64}$') { Pass "$where not reachable now, and $httpJson holds a tokenSha256 (a bridge started later is token-locked)" }
      else { Fail "$where not reachable now, but $httpJson holds no 64-hex tokenSha256: the bridge refuses to start without it. Run 'node claude-async-http.mjs --new-token'." }
      continue
    }
    if ($v -eq "CLOSED") { Pass "$where not reachable"; continue }
    if ($t.port -eq 7842) {
      # Reachable is acceptable only if the bridge is token-locked: an unauthenticated MCP request must get 401.
      # Host: 127.0.0.1:7842 is what a job would send to get past the bridge's DNS-rebinding filter (any
      # other Host gets 403 from an UNLOCKED bridge, which would make an open bridge look closed).
      $c = Invoke-InContainer @() "curl -s -o /dev/null -w '%{http_code}' --max-time 5 -X POST -H 'Host: 127.0.0.1:7842' -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -d '{""jsonrpc"":""2.0"",""id"":1,""method"":""tools/list""}' http://$($t.host):7842/mcp"
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
targets=$(awk '$5 ~ /^\/(workspace|home\/agent\/\.claude\/CLAUDE\.md|opt\/claude-async\/hooks|run\/claude-async\/creds)$/ {print $5}' /proc/self/mountinfo | sort | tr '\n' ' ')
echo "BIND_TARGETS $targets"
case "$targets" in *"/workspace"*) echo "WORKSPACE_IS_A_MOUNT"; bad=1 ;; esac
[ -z "$(ls -A /workspace)" ] || { echo "WORKSPACE_NOT_EMPTY"; bad=1; }
touch /home/agent/.claude/CLAUDE.md 2>/dev/null && { echo "CLAUDE_MD_WRITABLE"; bad=1; }
touch /opt/claude-async/hooks/x 2>/dev/null && { echo "HOOKS_WRITABLE"; bad=1; }
touch /workspace/.smoke-write && rm /workspace/.smoke-write || { echo "WORKSPACE_NOT_WRITABLE"; bad=1; }
env | cut -d= -f1 | grep -E "TOKEN|SECRET|PASSWORD|API_KEY" && bad=1
# the GitHub App credential path: helper wired for github.com, gh is the wrapper over the real binary,
# the creds mount point exists and is empty without the mount, and nothing answers without a token file
[ "$(git config --system credential.https://github.com.helper)" = "/usr/local/bin/claude-async-git-credential" ] || { echo "HELPER_NOT_CONFIGURED"; bad=1; }
git config --system --get-all credential.helper | grep -q "gh auth" && { echo "OLD_GH_HELPER_PRESENT"; bad=1; }
head -1 /usr/local/bin/gh | grep -q "^#!/bin/bash" && [ -x /usr/local/lib/gh/gh ] || { echo "GH_WRAPPER_MISSING"; bad=1; }
[ -d /run/claude-async/creds ] && [ -z "$(ls -A /run/claude-async/creds)" ] || { echo "CREDS_DIR_NOT_EMPTY_OR_MISSING"; bad=1; }
[ -z "$(printf 'protocol=https\nhost=github.com\n\n' | /usr/local/bin/claude-async-git-credential get)" ] || { echo "HELPER_ANSWERS_WITHOUT_FILE"; bad=1; }
gh --version | head -1
exit $bad
'@
$r = Invoke-InContainer $roMounts $check
if ($r.code -eq 0) { Pass "no Docker socket, no host credential paths, only CLAUDE.md/hooks mounted (read-only), /workspace container-local and empty, credential helper + gh wrapper in place, no secrets without -EnvFile`n$($r.out.Trim())" }
else { Fail "isolation check:`n$($r.out)" }

# --- 5b. Token file propagation through a bind mount (the runner's refresh path) -------------
# The runner publishes each token generation by writing a temp file inside <jobdir>\creds and
# renaming it over creds\token (atomic: readers never see a torn file); if that rename fails it falls
# back to rewriting the file in place. Both are measured here, each with SAME-LENGTH content (real
# tokens all have one length, so st_size never changes; Docker Desktop's WSL2 file sharing could in
# principle serve a cached copy when only the content changes). The writes are done by node exactly
# as job-runner.mjs does them. A container tails the file; each new value must show up within 5 s.
$propDir = Join-Path ([IO.Path]::GetTempPath()) ("claude-async-smoke-creds-" + [IO.Path]::GetRandomFileName())
New-Item -ItemType Directory -Path $propDir | Out-Null
$propFile = Join-Path $propDir "token"
$utf8 = New-Object Text.UTF8Encoding($false)
[IO.File]::WriteAllText($propFile, "generation-one`n", $utf8)
$propName = "claude-async-smoke-prop-" + [IO.Path]::GetRandomFileName().Replace(".", "")
$propMount = "type=bind,source=$($propDir -replace '\\','/'),target=/run/claude-async/creds,readonly"
# base64, like Invoke-InContainer: PowerShell 5.1 would not escape the embedded quotes for docker.exe
$propScript = 'for i in $(seq 1 80); do echo "SEEN:$(cat /run/claude-async/creds/token 2>/dev/null || echo READ_FAILED)"; sleep 0.25; done'
$propB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($propScript))
# node one-liners: the in-place rewrite (open r+, write at 0, truncate, fsync) and the rename publication.
# No double quotes inside them: PowerShell 5.1 does not escape embedded quotes for native commands.
$jsInPlace = 'const fs=require(''fs'');const [f,v]=process.argv.slice(1);const d=v+String.fromCharCode(10);const fd=fs.openSync(f,''r+'');fs.writeSync(fd,d,0);fs.ftruncateSync(fd,Buffer.byteLength(d));fs.fsyncSync(fd);fs.closeSync(fd)'
$jsRename = 'const fs=require(''fs'');const [f,v]=process.argv.slice(1);const d=v+String.fromCharCode(10);const t=f+''.tmp-smoke'';const fd=fs.openSync(t,''wx'',0o600);fs.writeSync(fd,d,0);fs.fsyncSync(fd);fs.closeSync(fd);fs.renameSync(t,f)'
function Wait-Seen([string]$value) {
  $t0 = Get-Date; $logs = ""
  while (((Get-Date) - $t0).TotalSeconds -lt 5) {
    $logs = (& $Docker logs $propName 2>&1 | Out-String)
    if ($logs -match "SEEN:$value") { return @{ seen = $true; ms = [int]((Get-Date) - $t0).TotalMilliseconds; logs = $logs } }
    Start-Sleep -Milliseconds 200
  }
  return @{ seen = $false; ms = 5000; logs = $logs }
}
$prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
try {
  $propArgs = @("run", "-d", "--name", $propName, "--pull=never", "--init", "--user", "1000:1000", "--security-opt", "no-new-privileges",
                "--cap-drop", "ALL", "--network", "none", "--mount", $propMount, $script:imageRef, "bash", "-c", "echo $propB64 | base64 -d | bash")
  $cid = (& $Docker @propArgs 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { Fail "token propagation: could not start the tailing container: $cid" }
  else {
    Start-Sleep -Seconds 2
    $logs0 = (& $Docker logs $propName 2>&1 | Out-String)
    if ($logs0 -notmatch "SEEN:generation-one") { Fail "token propagation: the container did not read the initial file through the read-only creds mount: $($logs0.Trim())" }
    else {
      # (1) same-length in-place rewrite: generation-one -> generation-two (15 bytes each)
      & node -e $jsInPlace $propFile "generation-two" 2>&1 | Out-Null
      $inPlace = Wait-Seen "generation-two"
      # (2) same-length rename publication: -> generation-333 (15 bytes)
      & node -e $jsRename $propFile "generation-333" 2>&1 | Out-Null
      $renamed = Wait-Seen "generation-333"
      $last = { param($l) (($l.Trim() -split "`r?`n" | Select-Object -Last 3) -join ' | ') }
      if ($renamed.seen) { Pass "token propagation (rename, what the runner does): a same-length file renamed into the mounted creds dir was visible in the running container after $($renamed.ms) ms" }
      else { Fail "token propagation (rename): the container did NOT see a file renamed into the mounted creds directory within 5 s (last lines: $(& $last $renamed.logs)). Container jobs longer than an hour would lose GitHub access. Do not enable container mode until this passes (docs/container-jobs.md, 'Token delivery and refresh')." }
      if ($inPlace.seen) { Pass "token propagation (in-place fallback): a same-length in-place rewrite was visible after $($inPlace.ms) ms" }
      else { Warn "token propagation (in-place fallback): a same-length in-place rewrite was NOT visible within 5 s (last lines: $(& $last $inPlace.logs)); the runner's fallback (used only when the rename fails) would not reach running jobs" }
    }
  }
} finally {
  & $Docker rm -f $propName *> $null
  $ErrorActionPreference = $prev
  Remove-Item -Recurse -Force $propDir -ErrorAction SilentlyContinue
}

# --- 6. Credentials (optional): the OAuth env file and the GitHub App ------------------------
if ($EnvFile -or $AppId -or $AppKeyFile) {
  if (-not $EnvFile) { Fail "-EnvFile is required together with the GitHub App settings" }
  elseif (-not (Test-Path -LiteralPath $EnvFile)) { Fail "env file $EnvFile not found" }
  elseif (-not $AppId -or -not $AppKeyFile) { Fail "the GitHub App settings are required with -EnvFile: -AppId and -AppKeyFile (or CLAUDE_ASYNC_GITHUB_APP_ID / CLAUDE_ASYNC_GITHUB_APP_KEY_FILE in the environment)" }
  elseif (-not (Test-Path -LiteralPath $AppKeyFile)) { Fail "GitHub App key file $AppKeyFile not found" }
  else {
    # the env file may hold only CLAUDE_CODE_OAUTH_TOKEN now (GH_TOKEN is refused by job-core)
    # blank and '#' comment lines are skipped, as container.mjs checkEnvFile() does (review round 3, C2)
    $keys = @(Get-Content -LiteralPath $EnvFile | Where-Object { $_.Trim() -ne "" -and -not $_.TrimStart().StartsWith("#") -and $_ -match "=" } | ForEach-Object { ($_ -split "=", 2)[0] })
    if (($keys -join ",") -eq "CLAUDE_CODE_OAUTH_TOKEN") { Pass "env file holds exactly CLAUDE_CODE_OAUTH_TOKEN" }
    else { Fail "env file keys are '$($keys -join ',')'; container jobs accept only CLAUDE_CODE_OAUTH_TOKEN (GitHub credentials come from the App; remove GH_TOKEN)" }
    $envArgs = @("--env-file", $EnvFile)
    $r = Invoke-InContainer $envArgs 'v=$(printenv CLAUDE_CODE_OAUTH_TOKEN || true); echo "CLAUDE_CODE_OAUTH_TOKEN length=${#v}"; env | grep -c "^GH_TOKEN=" || true'
    if ($r.code -eq 0 -and $r.out -match "CLAUDE_CODE_OAUTH_TOKEN length=[1-9]" -and $r.out -match "(?m)^0\s*$") { Pass "the OAuth token reaches the container as env (name/length only shown); no GH_TOKEN in the environment" }
    else { Fail "env file in the container: $($r.out)" }
    # Mint one installation token the way the runner does (tools/mint-app-token.mjs runs job-core's
    # preflight first: key file mode/shape, the installation on -Repo, the App's slug and bot id).
    $credsDir = Join-Path ([IO.Path]::GetTempPath()) ("claude-async-smoke-app-" + [IO.Path]::GetRandomFileName())
    New-Item -ItemType Directory -Path $credsDir | Out-Null
    $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    icacls $credsDir /inheritance:r /grant:r "${me}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" *> $null
    # the caller's own values are saved and put back afterwards, never deleted (review round 3, C2)
    $prevAppId = $env:CLAUDE_ASYNC_GITHUB_APP_ID; $prevAppKey = $env:CLAUDE_ASYNC_GITHUB_APP_KEY_FILE
    try {
      $env:CLAUDE_ASYNC_GITHUB_APP_ID = $AppId; $env:CLAUDE_ASYNC_GITHUB_APP_KEY_FILE = $AppKeyFile
      $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
      try { $mint = (& node (Join-Path $repoRoot "tools\mint-app-token.mjs") $Repo (Join-Path $credsDir "token") 2>&1 | Out-String) } finally { $ErrorActionPreference = $prev }
      if ($LASTEXITCODE -ne 0) { Fail "GitHub App preflight/mint failed (this is what job-core's preflight would say):`n$($mint.Trim())" }
      else {
        Pass "GitHub App preflight + installation token for ${Repo}:`n$($mint.Trim())"
        $credsMount = @("--mount", "type=bind,source=$($credsDir -replace '\\','/'),target=/run/claude-async/creds,readonly")
        # single-quoted: bash's $(...) and ${#t} must reach the container untouched by PowerShell
        $body = 'set -e; t=$(cat /run/claude-async/creds/token); echo "token file length=${#t}"; echo "env GH_TOKEN count=$(env | grep -c ''^GH_TOKEN='' || true)"; a=$(gh auth token); [ "$a" = "$t" ] && echo GH_WRAPPER_USES_FILE || echo GH_WRAPPER_MISMATCH; gh api repos/__REPO__ --jq .full_name'
        $r = Invoke-InContainer ($envArgs + $credsMount) ($body.Replace("__REPO__", $Repo))
        if ($r.code -eq 0 -and $r.out -match "token file length=[1-9]" -and $r.out -match "env GH_TOKEN count=0" -and $r.out -match "GH_WRAPPER_USES_FILE" -and $r.out -match [regex]::Escape($Repo)) {
          Pass "the container reads the token through the read-only creds mount, the shell env has no GH_TOKEN, gh authenticates as the App for $Repo"
        } else { Fail "creds mount / gh wrapper / App access: $($r.out)" }
        $r = Invoke-InContainer ($envArgs + $credsMount) "git ls-remote https://github.com/$Repo HEAD | cut -c1-12"
        if ($r.code -eq 0 -and $r.out.Trim()) { Pass "git over https uses the installation token through the image's credential helper ($Repo)" } else { Fail "git credential helper / repo access: $($r.out)" }
        $r = Invoke-InContainer ($envArgs + $credsMount) "/usr/local/bin/claude-async-job-entry $Repo '' -- bash -c 'git log -1 --format=%h; git remote get-url origin; ! grep -rq x-access-token .git/config'"
        if ($r.code -eq 0) { Pass "the entrypoint clones $Repo into /workspace; no token in .git/config:`n$($r.out.Trim())" } else { Fail "entrypoint clone (exit $($r.code)): $($r.out)" }
        if ($RunClaude) {
          $r = Invoke-InContainer ($envArgs + $credsMount + $roMounts) "/usr/local/bin/claude-async-job-entry $Repo '' -- claude -p --dangerously-skip-permissions --setting-sources user --strict-mcp-config --mcp-config '{""mcpServers"":{}}' --model=claude-sonnet-5 --effort low -- 'Reply with exactly the word PONG and nothing else.'"
          if ($r.code -eq 0 -and $r.out -match "PONG") { Pass "claude -p ran headless on the subscription token, in the clone, like a real job" } else { Fail "claude headless call: $($r.out)" }
        }
      }
    } finally {
      Remove-Item -Recurse -Force $credsDir -ErrorAction SilentlyContinue
      if ($null -eq $prevAppId) { Remove-Item Env:CLAUDE_ASYNC_GITHUB_APP_ID -ErrorAction SilentlyContinue } else { $env:CLAUDE_ASYNC_GITHUB_APP_ID = $prevAppId }
      if ($null -eq $prevAppKey) { Remove-Item Env:CLAUDE_ASYNC_GITHUB_APP_KEY_FILE -ErrorAction SilentlyContinue } else { $env:CLAUDE_ASYNC_GITHUB_APP_KEY_FILE = $prevAppKey }
    }
  }
}

Write-Host ""
if ($warnings.Count -gt 0) { Write-Host "$($warnings.Count) warning(s): review them (phase 1 accepts LAN/tailnet reachability; see docs/container-jobs.md)." -ForegroundColor Yellow }
if ($failures.Count -eq 0) { Write-Host "SMOKE TEST PASS ($Image $($script:imageRef))" -ForegroundColor Green; exit 0 }
Write-Host "SMOKE TEST FAIL: $($failures.Count) check(s) failed" -ForegroundColor Red
exit 1
