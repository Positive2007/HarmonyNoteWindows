@echo off
rem HarmonyNote firewall rule (port 8787). ASCII only.
rem Auto-elevates to administrator because netsh needs admin rights.

net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Requesting administrator rights...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

echo Adding firewall rule for HarmonyNote (TCP 8787)...
netsh advfirewall firewall delete rule name="HarmonyNote-LAN" >nul 2>&1
netsh advfirewall firewall add rule name="HarmonyNote-LAN" dir=in action=allow protocol=TCP localport=8787 profile=any
if %errorlevel% equ 0 (
  echo.
  echo [OK] Firewall rule added. Phone can now reach this PC on port 8787.
) else (
  echo.
  echo [FAIL] Could not add the rule. Add it manually:
  echo   Control Panel - Windows Defender Firewall - Advanced settings
  echo   Inbound rule: allow TCP port 8787
)
echo.
pause
