@echo off
REM ============================================================
REM  iTools local launcher
REM  Double-click this file to start a local server and open
REM  the tools in your default browser.
REM  (Console text is kept in English to avoid code-page issues.)
REM ============================================================
cd /d "%~dp0"
set PORT=8080

REM ---- locate a Python interpreter ----
set "PY="
where python >nul 2>nul && set "PY=python"
if not defined PY ( where py >nul 2>nul && set "PY=py" )
if not defined PY (
  echo [ERROR] Python not found. Please install Python 3 first.
  pause
  exit /b 1
)

echo ============================================================
echo   iTools local server
echo   URL : http://localhost:%PORT%
echo   The browser will open automatically.
echo   *** Keep this black window open while using the tools. ***
echo   *** Close this window to stop the server.              ***
echo ============================================================

REM open browser first (server starts in a moment and will answer)
start "" "http://localhost:%PORT%/"

REM start the server (this blocks; closing the window stops it)
%PY% -m http.server %PORT%

REM if the server exits (port busy / stopped), keep the window so the message is visible
echo.
echo Server stopped. If it failed to start, port %PORT% may be in use.
pause
