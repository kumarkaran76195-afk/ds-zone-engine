@echo off
title DS Zone Engine
cd /d "%~dp0"

echo Starting DS Zone Engine...
start /min node server.js
timeout /t 4 /nobreak >nul

echo Starting Cloudflare Tunnel...
cloudflared tunnel --url http://127.0.0.1:3000 > tunnel_output.txt 2>&1

:loop
timeout /t 5 /nobreak >nul
findstr "trycloudflare.com" tunnel_output.txt >nul 2>&1
if %errorlevel%==0 (
    for /f "tokens=*" %%i in ('findstr "trycloudflare.com" tunnel_output.txt') do set URL=%%i
    echo.
    echo ==========================================
    echo   LIVE LINK: 
    echo ==========================================
    echo %URL%
    echo.
) else (
    goto loop
)
