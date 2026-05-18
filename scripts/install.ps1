# Mason installer for Windows. Usage:
#
#   irm https://raw.githubusercontent.com/databricks-solutions/mason/main/scripts/install.ps1 | iex
#
# Pin to a specific version:
#
#   $env:MASON_VERSION = "v1.3.13"; irm https://raw.githubusercontent.com/databricks-solutions/mason/main/scripts/install.ps1 | iex
#
# Downloads the latest Mason release for the current architecture (x64 or
# ARM64) and runs the NSIS installer in silent mode. Per-user install —
# no admin elevation required.

$ErrorActionPreference = "Stop"
$repo = "databricks-solutions/mason"

# --- Detect architecture ---
$arch = $env:PROCESSOR_ARCHITECTURE
if ($arch -eq "ARM64") {
    $suffix = "-arm64"
    $archLabel = "ARM64"
} elseif ($arch -eq "AMD64" -or $arch -eq "x86_64") {
    $suffix = ""
    $archLabel = "x64"
} else {
    Write-Host "[mason] Unsupported architecture: $arch (Mason supports x64 and ARM64)" -ForegroundColor Red
    exit 1
}

# --- Look up release ---
$tag = $env:MASON_VERSION
if ($tag) {
    Write-Host "[mason] Looking up release $tag for $archLabel..."
    $releaseUrl = "https://api.github.com/repos/$repo/releases/tags/$tag"
} else {
    Write-Host "[mason] Looking up latest release for $archLabel..."
    $releaseUrl = "https://api.github.com/repos/$repo/releases/latest"
}

try {
    $release = Invoke-RestMethod -Uri $releaseUrl -Headers @{
        "User-Agent" = "mason-installer"
        "Accept" = "application/vnd.github+json"
    }
} catch {
    Write-Host "[mason] Failed to query GitHub release: $_" -ForegroundColor Red
    exit 1
}

$version = $release.tag_name -replace "^v",""
$assetName = "Mason Setup $version$suffix.exe"
$asset = $release.assets | Where-Object { $_.name -eq $assetName }
if (-not $asset) {
    Write-Host "[mason] No release asset matching '$assetName' (architecture $archLabel)" -ForegroundColor Red
    Write-Host "[mason] Available assets:"
    $release.assets | ForEach-Object { Write-Host "  - $($_.name)" }
    exit 1
}

# --- Download ---
$tmp = Join-Path $env:TEMP $assetName
Write-Host "[mason] Downloading $assetName ($([math]::Round($asset.size / 1MB, 1)) MB)..."
try {
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmp -UseBasicParsing
} catch {
    Write-Host "[mason] Download failed: $_" -ForegroundColor Red
    exit 1
}

# --- Install ---
Write-Host "[mason] Running installer (per-user, no admin required)..."
# /S = silent install. electron-builder NSIS default install path is
# %LOCALAPPDATA%\Programs\mason\Mason.exe and the installer adds a
# Start-Menu shortcut + Desktop shortcut automatically.
$proc = Start-Process -FilePath $tmp -ArgumentList "/S" -PassThru -Wait
if ($proc.ExitCode -ne 0) {
    Write-Host "[mason] Installer exited with code $($proc.ExitCode)" -ForegroundColor Red
    Remove-Item $tmp -ErrorAction SilentlyContinue
    exit 1
}

$installPath = Join-Path $env:LOCALAPPDATA "Programs\mason\Mason.exe"
Remove-Item $tmp -ErrorAction SilentlyContinue

if (Test-Path $installPath) {
    Write-Host "[mason] Installed at $installPath" -ForegroundColor Green
    Write-Host "[mason] Launching..."
    Start-Process $installPath
} else {
    Write-Host "[mason] Install completed. Launch Mason from the Start Menu." -ForegroundColor Green
}
