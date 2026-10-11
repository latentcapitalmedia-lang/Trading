@echo off
rem chartink-crypto launcher
setlocal
set PY="%LOCALAPPDATA%\Programs\Python\Python313\python.exe"
if not exist %PY% set PY=python
cd /d "%~dp0"
start "chartink-crypto" %PY% app.py
timeout /t 2 >nul
start "" http://127.0.0.1:5000/
