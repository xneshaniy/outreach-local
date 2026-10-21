<#
.SYNOPSIS
    Verifies that the deployment bundle starts correctly in every layout a
    hosting platform can produce.

.DESCRIPTION
    Hostinger can start a Node.js app in more than one way:
      - from the application root, with the entry file inside the bundle
      - from the application root, with the entry file inside the output
        directory
      - with the working directory set to the output directory

    The bundle's launcher resolves its own location, so all three must work.
    This script builds the bundle, copies it to a throwaway directory and
    starts it in each layout, then checks the health endpoint and the logs.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/simulate-hostinger.ps1
#>
$ErrorActionPreference = "Continue"

$projectRoot = Split-Path -Parent $PSScriptRoot
$env:Path = "$env:LOCALAPPDATA\Programs\nodejs\node-v22.23.3-win-x64;$env:Path"

# --- Where to put the throwaway copies -------------------------------------
$workRoot = Join-Path $env:TEMP "opencode\hostinger-sim"
$repoRoot = Join-Path $env:TEMP "opencode\hostinger-repo"
$bundleDir = Join-Path $workRoot "deploy"

# --- Database / secrets -----------------------------------------------------
# Override these with your own values if you want to test against a real
# database. The default points at the local development database.
$env:DATABASE_URL = $env:DATABASE_URL
if (-not $env:DATABASE_URL) {
    Write-Warning "DATABASE_URL is not set - the health check will fail. That is expected."
}
$env:AUTH_SECRET = $env:AUTH_SECRET
if (-not $env:AUTH_SECRET) { $env:AUTH_SECRET = "sim-only-auth-secret-0123456789abcdefghijklmnop" }
$env:ENCRYPTION_KEY = $env:ENCRYPTION_KEY
if (-not $env:ENCRYPTION_KEY) { $env:ENCRYPTION_KEY = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=" }
$env:NODE_ENV = "production"
$env:HOSTNAME = "0.0.0.0"

function Stop-Bundle {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
        Where-Object { $_.CommandLine -match "hostinger-(sim|repo)" } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 2
}

function Test-Layout {
    param([string]$Name, [string]$WorkDir, [string]$Entry, [int]$Port)

    Stop-Bundle
    $env:APP_URL = "http://localhost:$Port"
    $env:PORT = "$Port"

    Write-Host ""
    Write-Host "=== $Name ===" -ForegroundColor Cyan
    Write-Host "    cwd    : $WorkDir"
    Write-Host "    command: node $Entry"

    Push-Location $WorkDir
    Start-Process -FilePath "node.exe" -ArgumentList $Entry -WorkingDirectory (Get-Location).Path `
        -RedirectStandardOutput "$env:TEMP\sim.log" -RedirectStandardError "$env:TEMP\sim.err.log" -NoNewWindow
    Pop-Location

    Start-Sleep -Seconds 12

    $health = & curl.exe -s "http://localhost:$Port/api/health"
    $code = & curl.exe -s -o NUL -w "%{http_code}" "http://localhost:$Port/login"

    $log = Get-Content "$env:TEMP\sim.log" -ErrorAction SilentlyContinue |
        Select-String "launcher|Worker started" | ForEach-Object { $_.Line.Trim() }
    $err = ""
    if ((Get-Item "$env:TEMP\sim.err.log" -ErrorAction SilentlyContinue).Length -gt 0) {
        $err = (Get-Content "$env:TEMP\sim.err.log" | Select-Object -First 2) -join " | "
    }

    Write-Host "    health : $health"
    Write-Host "    /login : $code"
    $log | ForEach-Object { Write-Host "      $_" }
    Write-Host "    errors : $(if ($err) { $err } else { 'none' })"

    $ok = ($code -eq "200") -and ($log -match "starting the sender worker") -and (-not $err)
    if ($ok) { Write-Host "    RESULT : PASS" -ForegroundColor Green }
    else { Write-Host "    RESULT : FAIL" -ForegroundColor Red }
    return $ok
}

Write-Host "==> Building the deployment bundle" -ForegroundColor Cyan
Push-Location $projectRoot
& npm.cmd run build:deploy | Out-Null
Pop-Location

Write-Host "==> Preparing the throwaway layouts" -ForegroundColor Cyan
Remove-Item $workRoot, $repoRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $repoRoot | Out-Null
Copy-Item (Join-Path $projectRoot "deploy") -Destination $bundleDir -Recurse -Force

$results = @()
$results += Test-Layout -Name "inside the bundle dir (node start.js)" `
    -WorkDir $bundleDir -Entry "start.js" -Port 3555
$results += Test-Layout -Name "application root (node deploy/start.js)" `
    -WorkDir $repoRoot -Entry "deploy/start.js" -Port 3556
$results += Test-Layout -Name "output dir as cwd (node ../deploy/start.js)" `
    -WorkDir $bundleDir -Entry "../deploy/start.js" -Port 3557

Stop-Bundle

Write-Host ""
if ($results -notcontains $false) {
    Write-Host "ALL LAYOUTS PASSED" -ForegroundColor Green
    exit 0
}
Write-Host "SOME LAYOUTS FAILED" -ForegroundColor Red
exit 1
