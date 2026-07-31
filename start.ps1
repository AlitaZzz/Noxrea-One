# Noxrea AI Canvas - Startup Script (PowerShell)
# Usage: Right-click -> "Run with PowerShell"
#        Or in terminal: .\start.ps1

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Host.UI.RawUI.WindowTitle = "Noxrea AI Canvas"

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "    Noxrea AI Canvas - Startup" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# --- 1. Check Node.js ------------------------------------------------
try {
    $nodeVer = node --version
    Write-Host "[OK] Node.js $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "[ERR] Node.js not found. Please install Node.js 18+ and add it to PATH" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# --- 2. Check npm ----------------------------------------------------
try {
    $npmVer = npm --version
    Write-Host "[OK] npm $npmVer" -ForegroundColor Green
} catch {
    Write-Host "[ERR] npm not found." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host ""

# --- 3. Init .env ----------------------------------------------------
$envFile = Join-Path $ProjectRoot ".env"
if (-not (Test-Path $envFile)) {
    Write-Host "[..] First run: copying .env.example -> .env" -ForegroundColor Yellow
    Copy-Item (Join-Path $ProjectRoot ".env.example") $envFile
    Write-Host "[!!] Edit .env to set JWT_SECRET_KEY and ADMIN_PASSWORD!" -ForegroundColor Yellow
    Write-Host ""
}

# --- 4. Install dependencies ------------------------------------------
$nodeModules = Join-Path $ProjectRoot "node_modules"
if (-not (Test-Path $nodeModules)) {
    Write-Host "[..] Installing dependencies (npm install)..." -ForegroundColor Yellow
    Push-Location $ProjectRoot
    npm install
    Pop-Location
}
Write-Host "[OK] Dependencies ready" -ForegroundColor Green
Write-Host ""

# --- 5. Prisma migrate + seed -----------------------------------------
Write-Host "[..] Running Prisma migrate..." -ForegroundColor Yellow
Push-Location $ProjectRoot
npx prisma migrate dev --name init --skip-generate 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "[..] Prisma migrate skipped (already applied or no schema changes)" -ForegroundColor Yellow
}
Write-Host "[..] Running seed (admin account)..." -ForegroundColor Yellow
npx tsx --env-file=.env prisma/seed.ts
Pop-Location
Write-Host ""

# --- 6. Start dev (Next.js + Worker) ----------------------------------
Write-Host "[..] Starting Next.js dev server (http://localhost:3000) + Worker" -ForegroundColor Yellow
Push-Location $ProjectRoot
$devJob = Start-Process -FilePath "cmd.exe" -ArgumentList "/c cd /d `"$ProjectRoot`" && npm run dev" -WindowStyle Normal -PassThru
Pop-Location
Write-Host "[OK] Services starting in background..." -ForegroundColor Green

# --- 7. Open browser --------------------------------------------------
Write-Host "[..] Waiting for services to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 6
Write-Host "[OK] Opening browser..." -ForegroundColor Green
Start-Process "http://localhost:3000"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  All done!" -ForegroundColor Cyan
Write-Host "  Web:     http://localhost:3000" -ForegroundColor Cyan
Write-Host "  API:      http://localhost:3000/api/*" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Closing this window will NOT stop the servers." -ForegroundColor Yellow
Write-Host "Close the CMD window manually to stop them." -ForegroundColor Yellow
Write-Host ""
Read-Host "Press Enter to exit"
