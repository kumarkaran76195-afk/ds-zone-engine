@echo off
title DS Zone Engine
cd /d "%~dp0"

echo [1/2] Starting Server...
start /min node server.js
timeout /t 3 /nobreak >nul

echo [2/2] Starting Cloudflare Tunnel...
echo.
echo ============================================
echo   URL mil jayega neeche - copy karo!
echo ============================================
echo.
cloudflared tunnel --url http://127.0.0.1:3000
