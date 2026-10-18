@echo off
rem ============================================================
rem  One-click build: frontend + sync + Gradle + archive to out\
rem  Equivalent: powershell -ExecutionPolicy Bypass -File build_apk.ps1
rem  Options are documented in build_apk.ps1 (-Variant debug|release|both,
rem  -SkipWeb, -WebOnly, -JdkHome, -AndroidSdk).
rem ============================================================
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_apk.ps1" %*
if errorlevel 1 (
  echo [ERROR] build failed. See the output above.
  exit /b 1
)
echo [OK] done.
endlocal
