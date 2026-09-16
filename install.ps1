#
# astro installer for Windows PowerShell
# Usage:
#   irm https://astro-cli.vercel.app/install.ps1 | iex
#   or: irm https://raw.githubusercontent.com/cyberuz001/astro-cli/main/install.ps1 | iex
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
Write-Host "  ${muted}https://astro-cli.vercel.app${reset}"
Write-Host "  ${dim}--------------------------------------------------${reset}"
Write-Host ""

$TempInstaller = Join-Path $env:TEMP "astro-cli-windows-x64.exe"
$DownloadUrl = "https://github.com/cyberuz001/astro-cli/releases/download/v1.0.6/astro-cli-windows-x64.exe"
$FallbackUrl = "https://github.com/cyberuz001/astro-cli/releases/latest/download/astro-cli-windows-x64.exe"

Write-Host "  ${amber}>${reset} ${white}[1/3] downloading astro package...${reset}"

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
    Download-Package $DownloadUrl $TempInstaller
} catch {
    Write-Host "        ${amber}Retrying from latest release...${reset}"
    Download-Package $FallbackUrl $TempInstaller
}

Write-Host "  ${amber}>${reset} ${white}[2/3] setting up binaries and environment...${reset}"

$proc = Start-Process -FilePath $TempInstaller -ArgumentList "-y" -Wait -PassThru -WindowStyle Hidden

$AstroDir = Join-Path $env:USERPROFILE ".astro"
$BinDir = Join-Path $AstroDir "bin"
if (-not (Test-Path $BinDir)) {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
}

$CurrentPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($CurrentPath -notlike "*$BinDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$BinDir;$CurrentPath", "User")
}
$env:Path = "$BinDir;" + $env:Path

Remove-Item -Path $TempInstaller -Force -ErrorAction SilentlyContinue

Write-Host "  ${amber}>${reset} ${white}[3/3] installation complete!${reset}"

Write-Host ""
Write-Host "  ${dim}--------------------------------------------------${reset}"
Write-Host "  ${vortex}* astro installed successfully!${reset}"
Write-Host "  ${dim}--------------------------------------------------${reset}"
Write-Host ""
Write-Host "  ${muted}Open a NEW terminal window and run:${reset}"
Write-Host "    ${amber}astro${reset}"
Write-Host ""
Write-Host "  ${muted}Documentation & Models:${reset} ${vortex}https://astro-cli.vercel.app${reset}"
Write-Host ""
