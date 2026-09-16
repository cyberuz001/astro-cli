#
# Astro CLI installer for Windows PowerShell
# Usage:
#   irm https://raw.githubusercontent.com/cyberuz001/astro-cli/main/install.ps1 | iex
#

param(
    [Parameter(Position = 0)]
    [string]$Version = "1.0.6"
)

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host "       Astro CLI - Installing..." -ForegroundColor White
Write-Host "       Agentic AI Coding Assistant" -ForegroundColor Gray
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host ""

$AstroDir = Join-Path $env:USERPROFILE '.astro'
$BinDir = Join-Path $AstroDir 'bin'
New-Item -ItemType Directory -Path $BinDir -Force | Out-Null

$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'aarch64' } else { 'x86_64' }
$Platform = "windows-$Arch"
$BinaryName = "astro-$Version-$Platform.exe"
$DestFile = Join-Path $BinDir "astro.exe"

$Repo = if ($env:ASTRO_RELEASE_REPO) { $env:ASTRO_RELEASE_REPO } else { "cyberuz001/astro-cli" }
$DownloadUrl = "https://github.com/$Repo/releases/download/v$Version/$BinaryName"
$FallbackUrl = "https://github.com/$Repo/releases/latest/download/$BinaryName"

Write-Host "  [1/3] Downloading Astro CLI v$Version ($Platform)..." -ForegroundColor White

function Download-WithProgress([string]$Url, [string]$OutPath) {
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
                    Write-Host "`r        Progress: ${mb} MB / ${totalMb} MB (${percent}%)" -NoNewline -ForegroundColor DarkCyan
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
    Download-WithProgress $DownloadUrl $DestFile
} catch {
    Write-Host "        Retrying from latest release..." -ForegroundColor Yellow
    Download-WithProgress $FallbackUrl $DestFile
}

Write-Host "  [2/3] Configuring environment (PATH)..." -ForegroundColor White
$CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($CurrentPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$BinDir;$CurrentPath", "User")
    Write-Host "        Added $BinDir to PATH" -ForegroundColor Green
} else {
    Write-Host "        $BinDir already in PATH" -ForegroundColor DarkGray
}

Write-Host "  [3/3] Setting up configuration..." -ForegroundColor White
$ConfigFile = Join-Path $AstroDir "config.toml"
if (-not (Test-Path $ConfigFile)) {
    $cfg = @"
[cli]
installer = "gh-release"
auto_update = true

[ui]
permission_mode = "always-approve"
theme = "auto"

[models]
default = "photon-3.7"

[endpoints]
cli_chat_proxy_base_url = "http://localhost:5544/v1"
"@
    Set-Content -Path $ConfigFile -Value $cfg -Encoding UTF8
}

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "       Astro CLI installed successfully!" -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Open a NEW PowerShell or Terminal window and type:" -ForegroundColor White
Write-Host "    astro" -ForegroundColor Cyan
Write-Host ""
