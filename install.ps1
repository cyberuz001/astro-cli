#
# astro installer for Windows PowerShell
# Usage:
#   irm https://raw.githubusercontent.com/cyberuz001/astro-cli/main/install.ps1 | iex
#

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

$esc = [char]27
$vortex = "$esc[38;2;255;74;28m"   # #FF4A1C
$amber  = "$esc[38;2;255;174;25m"  # #FFAE19
$muted  = "$esc[38;2;142;124;119m" # #8E7C77
$dim    = "$esc[38;2;75;60;55m"    # #4B3C37
$white  = "$esc[38;2;247;235;232m" # #F7EBE8
$reset  = "$esc[0m"

Write-Host ""
Write-Host "  ${dim}--------------------------------------------------${reset}"
Write-Host "  ${vortex}* astro${reset} ${dim}//${reset} ${amber}autonomous ai engine${reset}"
Write-Host "  ${muted}https://www.astroai.uz${reset}"
Write-Host "  ${dim}--------------------------------------------------${reset}"
Write-Host ""

$AstroDir = Join-Path $env:USERPROFILE ".astro"
$BinDir = Join-Path $AstroDir "bin"
if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
}

# Clean stale lock files left behind by a crashed proxy.
#
# auth.json.lock is deliberately excluded. It backs the CLI's own file lock,
# and the CLI re-validates it by inode before persisting a refreshed token: if
# the file has been unlinked it concludes it lost the lock and abandons the
# write, so the refreshed token never reaches disk and the next launch demands
# a fresh login. Removing it here was a direct cause of the repeated-login loop.
Get-ChildItem -Path $AstroDir -Filter "*.lock" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne 'auth.json.lock' } |
    Remove-Item -Force -ErrorAction SilentlyContinue

$TargetExe = Join-Path $BinDir "astro.exe"
$ProxyScript = Join-Path $BinDir "astro-proxy.mjs"
$ProxyEngine = Join-Path $BinDir "astro-proxy-engine.exe"
$LauncherCmd = Join-Path $BinDir "astro.cmd"
$ConfigFile = Join-Path $AstroDir "config.toml"

$DownloadUrl = "https://github.com/cyberuz001/astro-cli/releases/download/v1.0.6/astro-cli-windows-x64.exe"
$FallbackUrl = "https://github.com/cyberuz001/astro-cli/releases/latest/download/astro-cli-windows-x64.exe"
$ProxyScriptUrl = "https://raw.githubusercontent.com/cyberuz001/astro-cli/main/cli/astro-proxy.mjs"

Write-Host "  ${amber}>${reset} ${white}[1/4] downloading astro binary...${reset}"

function Download-Package([string]$Url, [string]$OutPath) {
    $request = [System.Net.HttpWebRequest]::Create($Url)
    $request.Timeout = 300000
    $request.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
    $response = $request.GetResponse()
    $totalBytes = $response.ContentLength
    $stream = $response.GetResponseStream()
    $fileStream = [System.IO.File]::Create($OutPath)
    $buffer = New-Object byte[] 65536
    $totalRead = 0
    $lastPercent = -1

    try {
        while (($read = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
            $fileStream.Write($buffer, 0, $read)
            $totalRead += $read
            if ($totalBytes -gt 0) {
                $percent = [math]::Min(100, [math]::Floor(($totalRead / $totalBytes) * 100))
                if ($percent -ne $lastPercent) {
                    $mb = [math]::Round($totalRead / 1MB, 1)
                    $totalMb = [math]::Round($totalBytes / 1MB, 1)
                    Write-Host "`r        ${muted}Progress: ${amber}${mb} MB${muted} / ${amber}${totalMb} MB${muted} (${vortex}${percent}%${muted})${reset}" -NoNewline
                    $lastPercent = $percent
                }
            }
        }
        Write-Host ""
    } finally {
        $fileStream.Close()
        $stream.Close()
        $response.Close()
    }

    # Verify before the file is treated as a working binary. A truncated
    # download, or an HTML error page served instead of the asset, otherwise
    # installs "successfully" and only fails much later as "astro does nothing".
    if (-not (Test-Path $OutPath)) { throw "download produced no file at $OutPath" }
    $actual = (Get-Item $OutPath).Length
    if ($totalBytes -gt 0 -and $actual -ne $totalBytes) {
        throw "download incomplete: got $actual of $totalBytes bytes"
    }
    if ($actual -lt 20MB) {
        throw "downloaded file is only $([math]::Round($actual/1MB,1)) MB; the release asset looks wrong"
    }
    # The CLI is a PE executable; anything else means we fetched a page.
    $head = [System.IO.File]::ReadAllBytes($OutPath)[0..1]
    if ($head[0] -ne 0x4D -or $head[1] -ne 0x5A) {
        throw "downloaded file is not a Windows executable (no MZ header)"
    }
}

try {
    Download-Package $DownloadUrl $TargetExe
} catch {
    Write-Host "        ${amber}Pinned release unavailable ($($_.Exception.Message)); trying latest...${reset}"
    try {
        Download-Package $FallbackUrl $TargetExe
    } catch {
        Write-Host ""
        Write-Host "  ${vortex}install failed:${reset} ${white}could not download the astro binary.${reset}"
        Write-Host "  ${muted}$($_.Exception.Message)${reset}"
        Write-Host ""
        Write-Host "  ${muted}If antivirus blocked it, see:${reset} ${vortex}https://www.astroai.uz${reset}"
        Write-Host "  ${muted}Or download manually:${reset}"
        Write-Host "    ${amber}$FallbackUrl${reset}"
        Write-Host ""
        exit 1
    }
}

Write-Host "  ${amber}>${reset} ${white}[2/4] downloading proxy engine & background worker...${reset}"
try {
    (New-Object System.Net.WebClient).DownloadFile($ProxyScriptUrl, $ProxyScript)
} catch {
    Write-Host "        ${muted}Fetching proxy from fallback mirror...${reset}"
    try {
        (New-Object System.Net.WebClient).DownloadFile("https://www.astroai.uz/cli/astro-proxy.mjs", $ProxyScript)
    } catch {
        Write-Host ""
        Write-Host "  ${vortex}install failed:${reset} ${white}could not download astro-proxy.mjs.${reset}"
        Write-Host "  ${muted}$($_.Exception.Message)${reset}"
        Write-Host ""
        exit 1
    }
}

# The proxy is the component that talks to the model API; a CDN error page
# saved in its place leaves an install that authenticates and then never
# answers, with nothing in the output to explain why.
if (-not (Test-Path $ProxyScript) -or (Get-Item $ProxyScript).Length -lt 10KB) {
    Write-Host ""
    Write-Host "  ${vortex}install failed:${reset} ${white}astro-proxy.mjs is missing or truncated.${reset}"
    Write-Host ""
    exit 1
}
if (-not (Select-String -Path $ProxyScript -Pattern 'astro-proxy' -Quiet -ErrorAction SilentlyContinue)) {
    Write-Host ""
    Write-Host "  ${vortex}install failed:${reset} ${white}astro-proxy.mjs does not look like the proxy.${reset}"
    Write-Host "  ${muted}A proxy or captive portal may have replaced the download.${reset}"
    Write-Host ""
    exit 1
}

# Resolve or download Node.js runtime for proxy
$nodeCmd = Get-Command node -ErrorAction SilentlyContinue
if (-not (Test-Path $ProxyEngine)) {
    if ($nodeCmd) {
        Copy-Item -Path $nodeCmd.Source -Destination $ProxyEngine -Force -ErrorAction SilentlyContinue
    } else {
        Write-Host "        ${muted}Downloading lightweight proxy runtime...${reset}"
        try {
            (New-Object System.Net.WebClient).DownloadFile("https://nodejs.org/dist/v20.18.0/win-x64/node.exe", $ProxyEngine)
        } catch {
            # Not fatal on its own: the launcher falls back to a `node` on
            # PATH. It used to swallow this silently and then the launcher
            # exited with no explanation at all.
            Write-Host "        ${muted}Could not fetch the bundled runtime; astro will use Node.js from PATH.${reset}"
        }
    }
}
if ((-not (Test-Path $ProxyEngine)) -and (-not $nodeCmd)) {
    Write-Host ""
    Write-Host "  ${vortex}install failed:${reset} ${white}no JavaScript runtime for the proxy.${reset}"
    Write-Host "  ${muted}Install Node.js 18+ from https://nodejs.org and re-run this installer.${reset}"
    Write-Host ""
    exit 1
}

Write-Host "  ${amber}>${reset} ${white}[3/4] configuring launcher & model presets...${reset}"

# Create astro.cmd launcher
$launcherContent = @"
@echo off
setlocal EnableExtensions
set "ASTRO_BIN=%~dp0"

call :isup && goto :run

if exist "%ASTRO_BIN%astro-proxy-engine.exe" (
  start "astro-proxy" /min "%ASTRO_BIN%astro-proxy-engine.exe" "%ASTRO_BIN%astro-proxy.mjs"
) else (
  where node >nul 2>&1
  if errorlevel 1 (
    echo [astro] No proxy runtime found. Reinstall astro, or install Node.js 18+.
    exit /b 1
  )
  start "astro-proxy" /min node "%ASTRO_BIN%astro-proxy.mjs"
)

for /l %%i in (1,1,40) do (
  call :isup && goto :run
  ping -n 2 127.0.0.1 >nul 2>&1
)
echo [astro] Proxy did not become ready within ~40s.
echo [astro] Check the minimised "astro-proxy" window for the reason.
exit /b 1

:run
"%ASTRO_BIN%astro.exe" %*
exit /b %errorlevel%

:isup
REM Anchored on ":5544" followed by LISTENING on the same line. The previous
REM `findstr "5544"` was an unanchored substring match, so it also matched
REM port 55440, port 15544 and any PID containing 5544. When it matched, the
REM launcher assumed the proxy was already running and never started it, so
REM the CLI came up against a dead port. Whether that happened depended on
REM what else the machine had open - hence "it only breaks on some PCs".
netstat -ano | findstr /r /c:":5544 .*LISTENING" >nul 2>&1
exit /b %errorlevel%
"@
Set-Content -Path $LauncherCmd -Value $launcherContent -Encoding ASCII

# Create config.toml if not exists
if (-not (Test-Path $ConfigFile)) {
    $configContent = @"
[marketplace]
default_skills_installs_purged = true

[cli]
installer = "internal"
auto_update = false

[ui]
max_thoughts_width = 120
fork_secondary_model = "nebula"
yolo = false
compact_mode = false
vim_mode = false
permission_mode = "always-approve"
theme = "oscura-midnight"

[models]
default = "vortex"
# Available models are discovered from the local proxy at runtime.

[endpoints]
# 127.0.0.1, not localhost: on most current Windows installs `localhost`
# resolves to ::1 first, and a proxy bound only to the IPv4 loopback is then
# unreachable. That presented as a CLI which authenticated fine and then never
# answered. Using the literal also skips a DNS lookup on every request and
# survives a mangled hosts file.
cli_chat_proxy_base_url = "http://127.0.0.1:5544/v1"
xai_api_base_url = "http://127.0.0.1:5544/v1"
"@
    Set-Content -Path $ConfigFile -Value $configContent -Encoding UTF8
}

Write-Host "  ${amber}>${reset} ${white}[4/4] configuring global PATH environment...${reset}"

# Configure User PATH.
#
# Written through the registry rather than [Environment]::SetEnvironmentVariable
# so an existing REG_EXPAND_SZ value keeps its type. SetEnvironmentVariable
# rewrites PATH as REG_SZ, after which entries that contain %VAR% stop
# expanding and unrelated tools break. `setx` is worse still: it also
# truncates at 1024 characters, silently destroying a long PATH.
$CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($CurrentPath -notlike "*$BinDir*") {
    $NewPath = if ([string]::IsNullOrEmpty($CurrentPath)) { $BinDir } else { "$BinDir;$CurrentPath" }
    $wrote = $false
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
        if ($key) {
            try {
                # DoNotExpandEnvironmentNames: read the raw value so its kind
                # can be detected without expanding it first.
                $existingKind = if ($null -eq $CurrentPath) {
                    [Microsoft.Win32.RegistryValueKind]::ExpandString
                } else {
                    $key.GetValueKind('Path')
                }
                $key.SetValue('Path', $NewPath, $existingKind)
                $wrote = $true
            } finally { $key.Close() }
        }
    } catch {
        Write-Host "        ${muted}Registry PATH write failed, falling back.${reset}"
    }
    if (-not $wrote) {
        [Environment]::SetEnvironmentVariable("Path", $NewPath, "User")
    } else {
        # `reg`-style writes do not broadcast WM_SETTINGCHANGE, so newly
        # opened terminals would not see the change until the next sign-in.
        # A short unrelated variable triggers the broadcast cheaply.
        [Environment]::SetEnvironmentVariable("ASTRO_HOME", $AstroDir, "User")
    }
}
$env:Path = "$BinDir;" + $env:Path

# Note: astro is deliberately NOT copied into C:\Windows.
#
# That used to be attempted on every install. It needs Administrator, so for
# most users it silently did nothing, and the PATH entry above is what made
# `astro` work. Where it did succeed it was actively harmful: dropping
# unsigned executables into the Windows directory is one of the strongest
# Defender heuristics there is (and a prime ASR trigger), it left stale copies
# that shadowed the real install after an upgrade, and it put files where an
# uninstall would never find them. ~/.astro/bin on PATH is the correct
# per-user location.

# Final check. "installed successfully" was previously printed unconditionally,
# even when a component had been removed by antivirus mid-install, so the user
# found out only when `astro` failed to do anything.
$required = @(
    @{ Path = $TargetExe;   Name = 'astro.exe' },
    @{ Path = $ProxyScript; Name = 'astro-proxy.mjs' },
    @{ Path = $LauncherCmd; Name = 'astro.cmd' }
)
$missing = @($required | Where-Object { -not (Test-Path $_.Path) } | ForEach-Object { $_.Name })

if ($missing.Count -gt 0) {
    Write-Host ""
    Write-Host "  ${dim}--------------------------------------------------${reset}"
    Write-Host "  ${vortex}install incomplete${reset}"
    Write-Host "  ${dim}--------------------------------------------------${reset}"
    Write-Host ""
    Write-Host "  ${white}Missing from ${BinDir}:${reset}"
    $missing | ForEach-Object { Write-Host "    ${amber}- $_${reset}" }
    Write-Host ""
    Write-Host "  ${muted}This usually means antivirus quarantined a file during install.${reset}"
    Write-Host "  ${muted}Restore it from Windows Security > Protection history, then add${reset}"
    Write-Host "  ${muted}an exclusion and re-run:${reset}"
    Write-Host "    ${amber}Add-MpPreference -ExclusionPath `"`$env:USERPROFILE\.astro`"${reset}"
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "  ${dim}--------------------------------------------------${reset}"
Write-Host "  ${vortex}* astro installed successfully!${reset}"
Write-Host "  ${dim}--------------------------------------------------${reset}"
Write-Host ""
Write-Host "  ${muted}Open a NEW terminal window and run:${reset}"
Write-Host "    ${amber}astro${reset}"
Write-Host ""
Write-Host "  ${muted}Documentation & Models:${reset} ${vortex}https://www.astroai.uz${reset}"
Write-Host ""
