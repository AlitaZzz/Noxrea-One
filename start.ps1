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

# --- 1. Check Python -------------------------------------------------
try {
    $pyVer = python --version
    Write-Host "[OK] $pyVer" -ForegroundColor Green
} catch {
    Write-Host "[ERR] Python not found. Please install Python 3.10+ and add it to PATH" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# --- 2. Check Node.js ------------------------------------------------
try {
    $nodeVer = node --version
    Write-Host "[OK] Node.js $nodeVer" -ForegroundColor Green
} catch {
    Write-Host "[ERR] Node.js not found. Please install Node.js 18+ and add it to PATH" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}
Write-Host ""

# --- 3. Init backend .env --------------------------------------------
$envFile = Join-Path $ProjectRoot "backend\.env"
if (-not (Test-Path $envFile)) {
    Write-Host "[..] First run: copying .env.example -> .env" -ForegroundColor Yellow
    Copy-Item (Join-Path $ProjectRoot "backend\.env.example") $envFile
    Write-Host "[!!] Edit backend\.env to set JWT_SECRET_KEY and ADMIN_PASSWORD!" -ForegroundColor Yellow
    Write-Host ""
}

# --- 4. Backend venv + deps ------------------------------------------
$venvDir = Join-Path $ProjectRoot "backend\venv"
if (-not (Test-Path $venvDir)) {
    Write-Host "[..] Creating Python virtual environment..." -ForegroundColor Yellow
    Push-Location (Join-Path $ProjectRoot "backend")
    python -m venv venv
    Pop-Location
}

Write-Host "[..] Installing backend dependencies..." -ForegroundColor Yellow
Push-Location (Join-Path $ProjectRoot "backend")
& "$venvDir\Scripts\pip.exe" install -r requirements.txt -q | Out-Null
Pop-Location
Write-Host "[OK] Backend dependencies ready" -ForegroundColor Green

# --- 5. Frontend deps ------------------------------------------------
$nodeModules = Join-Path $ProjectRoot "frontend\node_modules"
if (-not (Test-Path $nodeModules)) {
    Write-Host "[..] Installing frontend dependencies..." -ForegroundColor Yellow
    Push-Location (Join-Path $ProjectRoot "frontend")
    npm install
    Pop-Location
}
Write-Host "[OK] Frontend dependencies ready" -ForegroundColor Green
Write-Host ""

# --- 6. Start backend -------------------------------------------------
Write-Host "[..] Starting backend (FastAPI) -> http://localhost:8000" -ForegroundColor Yellow
$backendJob = Start-Process -FilePath "cmd.exe" -ArgumentList "/c cd /d `"$ProjectRoot\backend`" && `"$venvDir\Scripts\activate.bat`" && uvicorn app.main:app --reload --port 8000" -WindowStyle Normal -PassThru

# --- 7. Start frontend ------------------------------------------------
Write-Host "[..] Starting frontend (Next.js) -> http://localhost:3000" -ForegroundColor Yellow
$frontendJob = Start-Process -FilePath "cmd.exe" -ArgumentList "/c cd /d `"$ProjectRoot\frontend`" && npm run dev" -WindowStyle Normal -PassThru

# --- 8. Open browser --------------------------------------------------
Write-Host "[..] Waiting for services to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 6
Write-Host "[OK] Opening browser..." -ForegroundColor Green
Start-Process "http://localhost:3000"

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  All done!" -ForegroundColor Cyan
Write-Host "  Frontend: http://localhost:3000" -ForegroundColor Cyan
Write-Host "  Backend:  http://localhost:8000" -ForegroundColor Cyan
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Closing this window will NOT stop the servers." -ForegroundColor Yellow
Write-Host "Close the CMD windows manually to stop them." -ForegroundColor Yellow
Write-Host ""
Read-Host "Press Enter to exit"
