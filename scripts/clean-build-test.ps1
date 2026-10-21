$ErrorActionPreference = "Continue"
$env:Path = "$env:LOCALAPPDATA\Programs\nodejs\node-v22.23.3-win-x64;$env:Path"

$projectRoot = "C:\Users\Haseeb\Desktop\outrach system"
# A unique directory per run: Windows can hold file handles for a moment after
# a process exits, and a half-removed directory makes the clone fail.
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$work = Join-Path $env:TEMP "opencode\cleanbuild-$stamp"

Write-Host "==> Preparing $work" -ForegroundColor Cyan
if (Test-Path $work) {
    for ($i = 0; $i -lt 5 -and (Test-Path $work); $i++) {
        Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $work) { Start-Sleep -Seconds 2 }
    }
}
New-Item -ItemType Directory -Force -Path $work | Out-Null

Write-Host "==> Cloning the repository (exactly what the hosting platform does)" -ForegroundColor Cyan
Push-Location $work
$cloneOutput = & git clone --depth 1 "file:///$($projectRoot -replace '\\','/')" repo 2>&1
$cloneExit = $LASTEXITCODE
Pop-Location

if ($cloneExit -ne 0 -or -not (Test-Path "$work\repo\.git")) {
    Write-Host "CLONE FAILED:" -ForegroundColor Red
    $cloneOutput | ForEach-Object { Write-Host "    $_" }
    exit 1
}
Push-Location "$work\repo"
Write-Host "    commit: $(& git log --oneline -1)"

Write-Host ""
Write-Host "==> STEP 1: install command  (npm ci --include=dev)" -ForegroundColor Cyan
& npm.cmd ci --include=dev --no-audit --no-fund 2>&1 | Select-Object -Last 4
if ($LASTEXITCODE -ne 0) { Write-Host "INSTALL FAILED" -ForegroundColor Red; Pop-Location; exit 1 }

Write-Host ""
Write-Host "==> STEP 2: build command  (npm run build:host)" -ForegroundColor Cyan
& npm.cmd run build:host 2>&1 | Select-Object -Last 25
$buildExit = $LASTEXITCODE
Pop-Location

Write-Host ""
if ($buildExit -ne 0) {
    Write-Host "BUILD FAILED (exit $buildExit)" -ForegroundColor Red
    exit 1
}

Write-Host "==> Checking the output directory the platform expects" -ForegroundColor Cyan
foreach ($f in @("deploy\server\server.js", "deploy\worker\index.cjs", "deploy\start.js", "deploy\node_modules\.prisma\client", "deploy\package.json")) {
    $ok = Test-Path "$work\repo\$f"
    "{0,-40} {1}" -f $f, $(if ($ok) { "present" } else { "MISSING" })
}

Write-Host ""
Write-Host "==> Starting the bundle exactly as the platform would" -ForegroundColor Cyan
# The secrets are read from the environment - never hardcoded, because this
# file is committed.
if (-not $env:DATABASE_URL) { Write-Host "    (no DATABASE_URL set - the health check will report the database as down)"; $env:DATABASE_URL = "postgresql://127.0.0.1:1/none?connect_timeout=2" }
if (-not $env:AUTH_SECRET) { $env:AUTH_SECRET = "clean-build-test-auth-secret-0123456789abcdefghij" }
if (-not $env:ENCRYPTION_KEY) { $env:ENCRYPTION_KEY = "MDEyMzQ1Njc4OTAxMjM0NTY3ODkwMTIzNDU2Nzg5MDE=" }
$env:APP_URL = "http://localhost:3777"
$env:PORT = "3777"
$env:NODE_ENV = "production"
$env:HOSTNAME = "0.0.0.0"

Push-Location "$work\repo\deploy"
Start-Process -FilePath "node.exe" -ArgumentList "start.js" -WorkingDirectory (Get-Location).Path `
    -RedirectStandardOutput "$env:TEMP\cb.log" -RedirectStandardError "$env:TEMP\cb.err.log" -NoNewWindow
Pop-Location

Start-Sleep -Seconds 16
$health = & curl.exe -s "http://localhost:3777/api/health"
$code = & curl.exe -s -o NUL -w "%{http_code}" "http://localhost:3777/login"
Write-Host "    health : $health"
Write-Host "    /login : $code"
Get-Content "$env:TEMP\cb.log" -ErrorAction SilentlyContinue |
    Select-String "launcher|Worker started" | ForEach-Object { Write-Host "      $($_.Line.Trim())" }
$err = ""
if ((Get-Item "$env:TEMP\cb.err.log" -ErrorAction SilentlyContinue).Length -gt 0) {
    $err = (Get-Content "$env:TEMP\cb.err.log" | Select-Object -First 3) -join " | "
}
Write-Host "    errors : $(if ($err) { $err } else { 'none' })"

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match "cleanbuild" } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host ""
$healthText = "$health"
$workerStarted = (Get-Content "$env:TEMP\cb.log" -ErrorAction SilentlyContinue | Select-String "starting the sender worker").Count -gt 0

if ($healthText -match '"database":"up"') {
    Write-Host "CLEAN BUILD OK - the platform's build and start will work (with a database)" -ForegroundColor Green
    exit 0
}

# No database was configured. The app must still start, serve the pages, and
# say honestly that the database is down - that is what a hosting platform
# sees before the database is provisioned.
if ($code -eq "200" -and $workerStarted -and $healthText -match '"database":"down"') {
    Write-Host "CLEAN BUILD OK - the app starts, serves pages and starts the worker." -ForegroundColor Green
    Write-Host "  (no database was configured, so the health check reports database: down - correct)" -ForegroundColor DarkGray
    Write-Host "  set DATABASE_URL to also verify the database connection." -ForegroundColor DarkGray
    exit 0
}

Write-Host "CLEAN BUILD PROBLEM" -ForegroundColor Red
exit 1
