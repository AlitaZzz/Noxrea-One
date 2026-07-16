@echo off
chcp 65001 >nul
cd /d "%~dp0"

echo ========================================
echo   Noxrea AI Canvas - Startup Script
echo ========================================
echo.

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
