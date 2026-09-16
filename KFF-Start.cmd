@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\local-runtime.ps1" -Action Start -Open
if errorlevel 1 pause
