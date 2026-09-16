#
# Astro CLI installer for Windows PowerShell
# Usage:
#   irm https://raw.githubusercontent.com/cyberuz001/astro-cli/main/install.ps1 | iex
#

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$ProgressPreference = 'SilentlyContinue'

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host "       Astro CLI - Installing..." -ForegroundColor White
Write-Host "       Autonomous AI Coding Assistant" -ForegroundColor Gray
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host ""

$TempInstaller = Join-Path $env:TEMP "astro-cli-windows-x64.exe"
$DownloadUrl = "https://github.com/cyberuz001/astro-cli/releases/download/v1.0.6/astro-cli-windows-x64.exe"
$FallbackUrl = "https://github.com/cyberuz001/astro-cli/releases/latest/download/astro-cli-windows-x64.exe"

Write-Host "  [1/3] Downloading Astro CLI package..." -ForegroundColor White

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
    Download-Package $DownloadUrl $TempInstaller
} catch {
    Write-Host "        Retrying from latest release..." -ForegroundColor Yellow
    Download-Package $FallbackUrl $TempInstaller
}

Write-Host "  [2/3] Setting up binaries and environment..." -ForegroundColor White

$proc = Start-Process -FilePath $TempInstaller -ArgumentList "-y" -Wait -PassThru -WindowStyle Hidden

$BinDir = Join-Path $env:USERPROFILE ".astroin"
$CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($CurrentPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$BinDir;$CurrentPath", "User")
}
$env:Path = "$BinDir;" + $env:Path

Remove-Item -Path $TempInstaller -Force -ErrorAction SilentlyContinue

Write-Host "  [3/3] Installation complete!" -ForegroundColor White

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Green
Write-Host "       Astro CLI installed successfully!" -ForegroundColor Green
Write-Host "  ========================================" -ForegroundColor Green
Write-Host ""
Write-Host "  Open a NEW PowerShell or Terminal window and type:" -ForegroundColor White
Write-Host "    astro" -ForegroundColor Cyan
Write-Host ""
