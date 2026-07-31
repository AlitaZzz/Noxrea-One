@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   Noxrea AI Canvas - Startup Script
echo ========================================
echo.

where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERR] Node.js not found. Please install Node.js 18+ and add it to PATH
    pause
    exit /b 1
)

where npm >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERR] npm not found
    pause
    exit /b 1
)

where powershell >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERR] PowerShell not found
    pause
    exit /b 1
)

powershell -ExecutionPolicy Bypass -File "%~dp0start.ps1"
if %errorlevel% neq 0 (
    echo.
    pause
)
