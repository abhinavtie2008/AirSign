@echo off
setlocal
cd /d "%~dp0"
echo.
echo   AirSign - local MediaPipe setup
echo   -------------------------------
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required for the one-time dependency setup.
  echo Install the current Node.js LTS release from https://nodejs.org/ and run setup.bat again.
  echo.
  pause
  exit /b 1
)
echo Installing the pinned MediaPipe Hands package...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo.
  echo npm install failed. Check your internet connection and try again.
  pause
  exit /b 1
)
echo.
echo Copying the runtime assets into vendor\...
call npm run prepare-extension
if errorlevel 1 (
  echo.
  echo Asset preparation failed. Please check the error above.
  pause
  exit /b 1
)
echo.
echo AirSign is ready to load in Chrome.
echo Open chrome://extensions, turn on Developer mode, click Load unpacked, and select this folder:
echo %CD%
echo.
pause
