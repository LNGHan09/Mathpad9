@echo off
chcp 65001 >nul
cd /d "%~dp0"
if not exist .env (
  echo Chua co file .env. Hay sao chep .env.example thanh .env va dien JWT_SECRET truoc.
  pause
  exit /b 1
)
if not exist node_modules (
  echo Dang cai thu vien...
  call npm install
  if errorlevel 1 (
    echo Cai thu vien that bai. Hay kiem tra ket noi mang va phien ban Node.js.
    pause
    exit /b 1
  )
)
call npm start
pause
