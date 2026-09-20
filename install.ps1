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

# Clean stale lock files
Get-ChildItem -Path $AstroDir -Filter "*.lock" -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

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
}

try {
    Download-Package $DownloadUrl $TargetExe
} catch {
    Write-Host "        ${amber}Retrying from latest release...${reset}"
    Download-Package $FallbackUrl $TargetExe
}

Write-Host "  ${amber}>${reset} ${white}[2/4] downloading proxy engine & background worker...${reset}"
try {
    (New-Object System.Net.WebClient).DownloadFile($ProxyScriptUrl, $ProxyScript)
} catch {
    Write-Host "        ${muted}Fetching proxy from fallback mirror...${reset}"
    (New-Object System.Net.WebClient).DownloadFile("https://www.astroai.uz/cli/astro-proxy.mjs", $ProxyScript)
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
        } catch {}
    }
}

Write-Host "  ${amber}>${reset} ${white}[3/4] configuring launcher & model presets...${reset}"

# Create astro.cmd launcher
$launcherContent = @"
@echo off
REM astro CLI launcher
netstat -ano 2>nul | findstr "5544" | findstr "LISTENING" >nul 2>&1
if errorlevel 1 (
  if exist "%~dp0astro-proxy-engine.exe" (
    start /B "" "%~dp0astro-proxy-engine.exe" "%~dp0astro-proxy.mjs" >nul 2>&1
  ) else (
    where node >nul 2>&1
    if not errorlevel 1 (
      start /B "" node "%~dp0astro-proxy.mjs" >nul 2>&1
    )
  )
  ping -n 3 127.0.0.1 >nul 2>&1
)
"%~dp0astro.exe" %*
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
allowed_models = [
    "vortex",
    "nebula-high",
    "nebula",
    "photon-3.8",
    "photon-3.7",
]

[model.vortex]
model = "vortex"
name = "vortex"
context_window = 1000000

[model.nebula-high]
model = "nebula-high"
name = "nebula-high"
context_window = 200000

[model.nebula]
model = "nebula"
name = "nebula"
context_window = 200000

[model.photon-3.8]
model = "photon-3.8"
name = "photon-3.8"
context_window = 128000

[model.photon-3.7]
model = "photon-3.7"
name = "photon-3.7"
context_window = 128000

[endpoints]
cli_chat_proxy_base_url = "http://localhost:5544/v1"
xai_api_base_url = "http://localhost:5544/v1"
"@
    Set-Content -Path $ConfigFile -Value $configContent -Encoding UTF8
}

Write-Host "  ${amber}>${reset} ${white}[4/4] configuring global PATH environment...${reset}"

# Configure User PATH
$CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($CurrentPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$BinDir;$CurrentPath", "User")
}
$env:Path = "$BinDir;" + $env:Path

# If running elevated or C:\Windows is writable, copy globally
if (Test-Path "C:\Windows") {
    try {
        Copy-Item -Path $LauncherCmd -Destination "C:\Windows\astro.cmd" -Force -ErrorAction SilentlyContinue
        Copy-Item -Path $TargetExe -Destination "C:\Windows\astro.exe" -Force -ErrorAction SilentlyContinue
        Copy-Item -Path $ProxyScript -Destination "C:\Windows\astro-proxy.mjs" -Force -ErrorAction SilentlyContinue
        if (Test-Path $ProxyEngine) {
            Copy-Item -Path $ProxyEngine -Destination "C:\Windows\astro-proxy-engine.exe" -Force -ErrorAction SilentlyContinue
        }
    } catch {}
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
