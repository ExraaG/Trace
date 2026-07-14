$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$Repository = "ExraaG/Trace"
$ReleaseApi = "https://api.github.com/repos/$Repository/releases/latest"
$Esp32Index = "https://espressif.github.io/arduino-esp32/package_esp32_index.json"
$TraceHome = Join-Path $HOME ".trace"
$CliDirectory = Join-Path $TraceHome "bin"
$ArduinoCli = Join-Path $CliDirectory "arduino-cli.exe"
$TempDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("trace-install-" + [guid]::NewGuid())

function Write-Step([string]$Message) {
    Write-Host "`nTrace: $Message" -ForegroundColor Cyan
}
function Fail([string]$Message) {
    throw "Trace installer error: $Message"
}

try {
    if ($env:PROCESSOR_ARCHITECTURE -notin @("AMD64", "x86_64")) {
        Fail "The first Windows release supports x64 systems only."
    }

    New-Item -ItemType Directory -Force -Path $TempDirectory, $CliDirectory | Out-Null

    Write-Step "Finding the latest release"
    try {
        $Release = Invoke-RestMethod -Uri $ReleaseApi -Headers @{ Accept = "application/vnd.github+json" }
    } catch {
        Fail "No public Trace release is available. Make the repository public and publish a version tag first."
    }

    $InstallerAsset = $Release.assets | Where-Object {
        $_.name -match "x86_64.*-setup\.exe$" -or $_.name -match "x64.*-setup\.exe$"
    } | Select-Object -First 1
    if (-not $InstallerAsset) {
        $InstallerAsset = $Release.assets | Where-Object { $_.name -match "\.msi$" } | Select-Object -First 1
    }
    if (-not $InstallerAsset) {
        Fail "The latest release does not contain a Windows installer."
    }

    $InstallerPath = Join-Path $TempDirectory $InstallerAsset.name
    Write-Step "Downloading Trace for Windows"
    Invoke-WebRequest -Uri $InstallerAsset.browser_download_url -OutFile $InstallerPath

    Write-Step "Installing Trace"
    if ($InstallerPath.EndsWith(".msi", [StringComparison]::OrdinalIgnoreCase)) {
        $Process = Start-Process msiexec.exe -ArgumentList @("/i", "`"$InstallerPath`"", "/qn", "/norestart") -Wait -PassThru
    } else {
        $Process = Start-Process $InstallerPath -ArgumentList "/S" -Wait -PassThru
    }
    if ($Process.ExitCode -ne 0) {
        Fail "The Trace installer exited with code $($Process.ExitCode)."
    }

    if (-not (Test-Path $ArduinoCli)) {
        Write-Step "Installing Arduino CLI"
        $ArduinoRelease = Invoke-RestMethod -Uri "https://api.github.com/repos/arduino/arduino-cli/releases/latest" `
            -Headers @{ Accept = "application/vnd.github+json" }
        $ArduinoAsset = $ArduinoRelease.assets | Where-Object {
            $_.name -match "Windows_64bit\.zip$"
        } | Select-Object -First 1
        if (-not $ArduinoAsset) {
            Fail "The current Arduino CLI release does not contain a Windows x64 archive."
        }
        $ArduinoArchive = Join-Path $TempDirectory "arduino-cli.zip"
        $ArduinoExtracted = Join-Path $TempDirectory "arduino-cli"
        Invoke-WebRequest -Uri $ArduinoAsset.browser_download_url -OutFile $ArduinoArchive
        Expand-Archive -Path $ArduinoArchive -DestinationPath $ArduinoExtracted -Force
        $DownloadedCli = Get-ChildItem -Path $ArduinoExtracted -Filter "arduino-cli.exe" -Recurse | Select-Object -First 1
        if (-not $DownloadedCli) {
            Fail "arduino-cli.exe was not found in the downloaded archive."
        }
        Copy-Item $DownloadedCli.FullName $ArduinoCli -Force
    } else {
        Write-Step "Arduino CLI is already installed"
    }

    [Environment]::SetEnvironmentVariable("TRACE_ARDUINO_CLI", $ArduinoCli, "User")
    & $ArduinoCli config init 2>$null | Out-Null
    $Config = (& $ArduinoCli config dump 2>$null) -join "`n"
    if ($Config -notmatch [regex]::Escape($Esp32Index)) {
        & $ArduinoCli config add board_manager.additional_urls $Esp32Index
        if ($LASTEXITCODE -ne 0) { Fail "Could not configure the ESP32 package index." }
    }

    $InstalledCores = (& $ArduinoCli core list 2>$null) -join "`n"
    if ($InstalledCores -notmatch "(?m)^esp32:esp32\s") {
        Write-Step "Installing the ESP32 Arduino core (this can take several minutes)"
        & $ArduinoCli core update-index
        if ($LASTEXITCODE -ne 0) { Fail "Could not update the Arduino core index." }
        & $ArduinoCli core install esp32:esp32
        if ($LASTEXITCODE -ne 0) { Fail "Could not install the ESP32 Arduino core." }
    } else {
        Write-Step "ESP32 Arduino core is already installed"
    }

    Write-Step "Installation complete"
    Write-Host "Launch Trace from the Start menu."
} finally {
    if (Test-Path $TempDirectory) {
        Remove-Item -Path $TempDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
