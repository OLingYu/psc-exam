@echo off
rem ============================================================
rem  Rebuild psc-exam frontend, then sync dist -> app\src\main\assets
rem  Thin wrapper: the only implementation lives in build_apk.ps1 (-WebOnly).
rem  For the full APK build use build_apk.bat.
rem ============================================================
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_apk.ps1" -WebOnly
if errorlevel 1 (
  echo [ERROR] web build or sync failed.
  exit /b 1
)
echo [OK] web assets updated. Run build_apk.bat to package the APK.
endlocal
