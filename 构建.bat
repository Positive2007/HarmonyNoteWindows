@echo off
cd /d "%~dp0"
echo ========================================
echo   HarmonyNote Windows Builder
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install from https://nodejs.org first.
  pause
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Rust not found. Run rustup-init.exe first.
  pause
  exit /b 1
)

echo [1/2] Installing npm dependencies...
call npm install
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)

echo.
echo [2/2] Building... first build takes 5-15 minutes, please wait.
echo.
call npx tauri build
if errorlevel 1 (
  echo Build failed. Send the red error text to your assistant.
  pause
  exit /b 1
)

echo.
echo ========================================
echo BUILD OK!
echo Installer: src-tauri\target\release\bundle\nsis\
echo Portable : src-tauri\target\release\harmonynote-windows.exe
echo ========================================
pause
