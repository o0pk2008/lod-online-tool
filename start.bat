@echo off
setlocal EnableExtensions
title TwinScape LOD Online Tool

cd /d "%~dp0"

echo ========================================
echo   TwinScape LOD Online Tool
echo ========================================
echo.

where node >NUL 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js not found. Please install Node.js 18+.
    echo   https://nodejs.org/
    echo.
    pause
    exit /b 1
)

echo Found:
node -v
echo.

if not exist "node_modules\" (
    echo First run: installing dependencies...
    echo.
    call npm install
    if errorlevel 1 (
        echo.
        echo [ERROR] npm install failed.
        pause
        exit /b 1
    )
    echo.
)

if not defined PORT set "PORT=5178"

echo Starting http://localhost:%PORT%
echo LAN URL is printed in the Node log below.
echo Close this window to stop the server.
echo.

start "" "http://localhost:%PORT%"

call npm start
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
    echo.
    echo [ERROR] Server exited with code %EXIT_CODE%.
    pause
)

endlocal
exit /b %EXIT_CODE%