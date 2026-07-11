@echo off
title Codex Notify Hook Installer
powershell -NoProfile -ExecutionPolicy Bypass -Command "$c=(Get-Content -Raw '%~f0') -split ('::PS'+'BODY::'),2; Set-Content -LiteralPath ($env:TEMP+'\codex-notify-installer.ps1') -Value $c[1] -Encoding UTF8"
if not exist "%TEMP%\codex-notify-installer.ps1" ( echo [X] Failed to extract installer & pause & exit /b 1 )
powershell -NoProfile -ExecutionPolicy Bypass -File "%TEMP%\codex-notify-installer.ps1"
del "%TEMP%\codex-notify-installer.ps1" >nul 2>&1
echo.
pause
exit /b
::PSBODY::
# install-codex-notify-hook.ps1
# Installs/updates the Codex notify hook for the current user.
# - Edits config.toml surgically (backup first, verify, restore on failure).
# - Chains to the existing notifier (Computer Use turn-ended) so nothing breaks.
# - Safe to re-run any time (e.g. after Codex Desktop updates rotate the cua_node path).

$ErrorActionPreference = "Stop"

$CodexHome   = Join-Path $env:USERPROFILE ".codex"
$ConfigPath  = Join-Path $CodexHome "config.toml"
$HooksDir    = Join-Path $CodexHome "hooks"
$HookPath    = Join-Path $HooksDir "notify.ps1"
$OrigJson    = Join-Path $HooksDir "original-notify.json"
$LogPath     = Join-Path $HooksDir "notify-log.jsonl"

function Write-Step($msg)  { Write-Host "[*] $msg" }
function Write-Ok($msg)    { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "[!] $msg" -ForegroundColor Yellow }
function Fail($msg)        { Write-Host "[X] $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------
# 1. Pre-requirement checks
# ---------------------------------------------------------------
Write-Step "Checking prerequisites..."

if ($PSVersionTable.PSVersion.Major -lt 5) {
    Fail "PowerShell 5.1+ required. Found $($PSVersionTable.PSVersion)."
}

if (-not (Test-Path $ConfigPath)) {
    Fail "No config.toml found at $ConfigPath. Is Codex installed for this user?"
}
Write-Ok "Found config.toml"

$codexCmd = Get-Command codex -ErrorAction SilentlyContinue
if ($codexCmd) { Write-Ok "codex CLI found: $($codexCmd.Source)" }
else { Write-Warn2 "codex not on PATH. Hook still works for Desktop/app-server runs, but verify your install." }

# BurntToast for native Windows toasts (optional but recommended)
$hasBurntToast = [bool](Get-Module -ListAvailable -Name BurntToast)
if ($hasBurntToast) {
    Write-Ok "BurntToast module present (native toasts enabled)"
} else {
    Write-Warn2 "BurntToast not installed. Hook will fall back to a console beep."
    $answer = Read-Host "Install BurntToast now for proper Windows toasts? (y/n)"
    if ($answer -eq "y") {
        try {
            # PS 5.1 defaults to old TLS; PSGallery requires TLS 1.2
            [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

            # First-ever gallery install needs the NuGet provider; bootstrap silently
            if (-not (Get-PackageProvider -Name NuGet -ListAvailable -ErrorAction SilentlyContinue)) {
                Write-Step "Bootstrapping NuGet package provider (one-time)..."
                Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Scope CurrentUser -Force | Out-Null
            }

            Write-Step "Installing BurntToast from PSGallery..."
            Install-Module BurntToast -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop

            # Verify it actually landed instead of assuming
            $hasBurntToast = [bool](Get-Module -ListAvailable -Name BurntToast)
            if ($hasBurntToast) {
                Write-Ok "BurntToast installed and verified"
            } else {
                Write-Warn2 "Install command ran but module not found. Falling back to beep."
            }
        } catch {
            Write-Warn2 "BurntToast install failed: $($_.Exception.Message)"
            Write-Warn2 "Continuing anyway. Hook will beep instead of toast."
            Write-Warn2 "Manual fix: open PowerShell and run: Install-Module BurntToast -Scope CurrentUser"
        }
    } else {
        Write-Warn2 "Skipped. Re-run this installer any time to add toasts later."
    }
}

# ---------------------------------------------------------------
# 2. Parse the CURRENT notify line from config.toml (read-only!)
#    We need it to chain to the original notifier (Computer Use).
# ---------------------------------------------------------------
Write-Step "Reading current notify setting from config.toml (read-only)..."

$configText = Get-Content $ConfigPath -Raw
$notifyMatch = [regex]::Match($configText, '(?m)^[ \t]*notify\s*=\s*\[(.*?)\]')

$originalNotify = @()
if ($notifyMatch.Success) {
    $inner = $notifyMatch.Groups[1].Value
    # Extract every quoted element ('single' or "double" quoted TOML strings)
    $elemMatches = [regex]::Matches($inner, "'([^']*)'|`"((?:[^`"\\]|\\.)*)`"")
    foreach ($m in $elemMatches) {
        if ($m.Groups[1].Success) {
            $originalNotify += $m.Groups[1].Value          # literal string, no unescape
        } else {
            $originalNotify += ($m.Groups[2].Value -replace '\\\\', '\')  # basic string, unescape backslashes
        }
    }
}

if ($originalNotify.Count -gt 0) {
    # Guard 1: if notify already points at OUR hook, do not save it as "original"
    # (that would create the self-wrapping recursion bug seen on macOS).
    if ($originalNotify -join ' ' -match 'notify\.ps1') {
        Write-Warn2 "notify already points to this hook. Keeping previously saved original notifier."
        if (-not (Test-Path $OrigJson)) {
            Write-Warn2 "No original-notify.json found. Chain target will be empty (toast/log only)."
        }
    }
    else {
        # Guard 2: verify the original exe still exists (cua_node hash rotates on app updates)
        $origExe = $originalNotify[0]
        if (Test-Path $origExe) {
            Write-Ok "Current notifier found: $origExe"
        } else {
            Write-Warn2 "Configured notifier does not exist on disk (stale cua_node path?): $origExe"
            Write-Warn2 "Saving it anyway; the hook skips the chain call if the exe is missing."
        }
        $originalNotify | ConvertTo-Json | Set-Content -Path (New-Item -Force -ItemType File -Path $OrigJson).FullName -Encoding UTF8
        Write-Ok "Original notifier saved to original-notify.json"
    }
} else {
    Write-Warn2 "No notify line found in config.toml. Hook will run standalone (toast/log only)."
    if (Test-Path $OrigJson) { Remove-Item $OrigJson -Force }
}

# ---------------------------------------------------------------
# 3. Install / update the hook script (idempotent, hash-compared)
# ---------------------------------------------------------------
Write-Step "Installing hook script..."

New-Item -ItemType Directory -Force -Path $HooksDir | Out-Null

$hookContent = @'
param([string]$Payload)

# Codex notify hook
# 1) log  2) toast  3) chain to original Computer Use notifier

$hookDir  = "$env:USERPROFILE\.codex\hooks"
$logPath  = Join-Path $hookDir "notify-log.jsonl"
$origJson = Join-Path $hookDir "original-notify.json"

# --- 1) Log every payload (also your debug trail for handoff visibility) ---
try {
    $stamp = (Get-Date).ToString("o")
    Add-Content -Path $logPath -Value "{`"ts`":`"$stamp`",`"payload`":$Payload}"
} catch { }

# --- 2) Parse + toast ---
$type = "codex"; $msg = "Turn complete"
try {
    $data = $Payload | ConvertFrom-Json
    if ($data.type) { $type = $data.type }
    if ($data.'last-assistant-message') { $msg = $data.'last-assistant-message' }
    if ($msg.Length -gt 140) { $msg = $msg.Substring(0,140) + "..." }
} catch { }

try {
    if (Get-Module -ListAvailable -Name BurntToast) {
        Import-Module BurntToast -ErrorAction SilentlyContinue
        New-BurntToastNotification -Text "Codex: $type", $msg -ErrorAction SilentlyContinue
    } else {
        [console]::beep(800,200)
    }
} catch { }

# --- 3) Chain to original notifier (Computer Use), fire-and-forget ---
# Never -Wait: the turn-ended helper is known to hang/leak if waited on.
# Never chain if target is this script itself (recursion guard).
try {
    if (Test-Path $origJson) {
        $orig = Get-Content $origJson -Raw | ConvertFrom-Json
        if ($orig -is [string]) { $orig = @($orig) }
        $exe  = $orig[0]
        if ($exe -and ($exe -notmatch 'notify\.ps1') -and (Test-Path $exe)) {
            $args = @()
            if ($orig.Count -gt 1) { $args += $orig[1..($orig.Count-1)] }
            $args += $Payload
            Start-Process -FilePath $exe -ArgumentList $args -WindowStyle Hidden -ErrorAction SilentlyContinue
        }
    }
} catch { }
'@

$needWrite = $true
if (Test-Path $HookPath) {
    $existing = Get-Content $HookPath -Raw
    if ($existing -eq $hookContent) {
        Write-Ok "Hook already up to date, nothing to do."
        $needWrite = $false
    } else {
        $backup = "$HookPath.bak.$(Get-Date -Format yyyyMMdd-HHmmss)"
        Copy-Item $HookPath $backup
        Write-Warn2 "Existing hook differs. Backed up to $backup, updating."
    }
}

if ($needWrite) {
    Set-Content -Path $HookPath -Value $hookContent -Encoding UTF8
    Write-Ok "Hook written to $HookPath"
}

# ---------------------------------------------------------------
# 4. Smoke test
# ---------------------------------------------------------------
Write-Step "Running smoke test..."
& powershell -ExecutionPolicy Bypass -File $HookPath '{"type":"smoke-test","last-assistant-message":"Hook installed and firing correctly."}'
if (Test-Path $LogPath) {
    $last = Get-Content $LogPath -Tail 1
    Write-Ok "Log entry written: $last"
} else {
    Write-Warn2 "No log written. Check ExecutionPolicy / paths."
}

# ---------------------------------------------------------------
# 5. Update config.toml notify line (surgical, backup-first)
# ---------------------------------------------------------------
Write-Step "Updating notify line in config.toml..."

$hookPathToml  = $HookPath -replace '\\', '/'
$newNotifyLine = "notify = [ `"powershell`", `"-ExecutionPolicy`", `"Bypass`", `"-File`", `"$hookPathToml`" ]"

# Re-read fresh (avoid stale state), preserve content exactly as-is
$configText = [System.IO.File]::ReadAllText($ConfigPath)

if ($configText -match '(?m)^[ \t]*notify\s*=.*notify\.ps1') {
    Write-Ok "config.toml already points at the hook. Nothing to change."
}
elseif ($notifyMatch.Success) {
    # Sanity: our regex only matches single-line arrays. If a notify key exists
    # but did not match (multi-line array), bail out rather than risk duplicates.
    $backup = "$ConfigPath.bak.$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item $ConfigPath $backup
    Write-Ok "Backup written: $backup"

    # Replace exactly the matched notify line, touch nothing else
    $updated = $configText.Replace($notifyMatch.Value, $newNotifyLine)
    if ($updated -eq $configText) {
        Write-Warn2 "Replacement produced no change (unexpected). Config untouched."
    } else {
        [System.IO.File]::WriteAllText($ConfigPath, $updated)

        # Verify: exactly one notify line, and it points at the hook
        $verify = [System.IO.File]::ReadAllText($ConfigPath)
        $count  = ([regex]::Matches($verify, '(?m)^[ \t]*notify\s*=')).Count
        if ($count -eq 1 -and $verify -match [regex]::Escape('notify.ps1')) {
            Write-Ok "notify line updated and verified (1 notify key, points at hook)."
        } else {
            Write-Warn2 "Verification failed ($count notify keys found). Restoring backup!"
            Copy-Item $backup $ConfigPath -Force
            Fail "config.toml restored from backup. Please edit the notify line manually."
        }
    }
}
elseif ($configText -match '(?m)^[ \t]*notify\s*=') {
    Write-Warn2 "A notify key exists but is not a single-line array. Not touching it."
    Write-Warn2 "Please set it manually to:"
    Write-Host  "  $newNotifyLine"
}
else {
    # No notify at all: insert as a root key ABOVE the first [table]
    $backup = "$ConfigPath.bak.$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item $ConfigPath $backup
    Write-Ok "Backup written: $backup"

    $firstTable = [regex]::Match($configText, '(?m)^\s*\[')
    if ($firstTable.Success) {
        $updated = $configText.Insert($firstTable.Index, "$newNotifyLine`r`n")
    } else {
        $updated = $configText.TrimEnd() + "`r`n$newNotifyLine`r`n"
    }
    [System.IO.File]::WriteAllText($ConfigPath, $updated)
    Write-Ok "notify line inserted above the first [table] (root-key rule respected)."
}

Write-Host ""
Write-Host "================= DONE =================" -ForegroundColor Cyan
Write-Host "notify -> $HookPath"
Write-Host "Chain  -> original notifier preserved in original-notify.json"
Write-Host "Log    -> $LogPath"
Write-Host ""
Write-Host "After a Codex Desktop update rewrites notify (new cua_node hash),"
Write-Host "just re-run this installer once. It re-captures the new original"
Write-Host "notifier and re-points notify at the hook automatically."
Write-Host "========================================"
