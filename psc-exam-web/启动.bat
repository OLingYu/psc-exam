@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist node_modules (
  echo [1/2] 首次运行，正在安装依赖...
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败，请检查 Node.js 是否已安装。
    pause
    exit /b 1
  )
)

echo [2/2] 启动开发服务器 http://127.0.0.1:5173
start "" "http://127.0.0.1:5173"
call npm run dev
pause
