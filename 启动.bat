@echo off
REM ============================================================
REM  iTools local launcher
REM  Serves the web tools plus requirement-1/3 local APIs on
REM  the loopback address only.
REM ============================================================
cd /d "%~dp0"
set "PORT=8080"

REM ---- locate a Python interpreter ----
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY ( where py >nul 2>nul && set "PY=py" )
if not defined PY (
  echo [ERROR] Python not found. Please install Python 3 first.
  pause
  exit /b 1
)

REM ---- verify dependencies without installing anything ----
%PY% -c "import requests, qcloud_cos" >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Required Python packages are missing.
  echo Run this command in this folder, then start again:
  echo   %PY% -m pip install -r requirements.txt
  pause
  exit /b 1
)

echo ============================================================
echo   iTools local server
echo   URL : http://127.0.0.1:%PORT%/
echo   The browser will open automatically.
echo   *** Keep this black window open while using the tools. ***
echo   *** Close this window to stop the server.              ***
echo ============================================================

%PY% local_server.py --port %PORT% --open-browser
set "SERVER_EXIT=%ERRORLEVEL%"

echo.
echo Server stopped. If it failed to start, port %PORT% may be in use.
pause
exit /b %SERVER_EXIT%
