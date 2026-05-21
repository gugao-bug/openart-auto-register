@echo off
chcp 65001 >nul
cd /d "%~dp0"
node batch_register_roxy.js
pause
