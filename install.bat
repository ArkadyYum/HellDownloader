@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
title HellDownloader — Automatic Installer

echo ============================================================
echo   HellDownloader — Automatic Installer for Windows 10/11
echo ============================================================
echo.

set "PUB_DIR=%PUBLIC%\HellDownloader"
if "%PUBLIC%"=="" set "PUB_DIR=C:\Users\Public\HellDownloader"
set "BIN_DIR=%PUB_DIR%\bin"
if not exist "%BIN_DIR%" mkdir "%BIN_DIR%"

:: 1. Locate or automatically download portable Node.js (node.exe)
set "NODE_EXE="
where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  for /f "delims=" %%i in ('where node') do (
    if not defined NODE_EXE set "NODE_EXE=%%i"
  )
)
if not defined NODE_EXE (
  if exist "%BIN_DIR%\node.exe" set "NODE_EXE=%BIN_DIR%\node.exe"
)
if not defined NODE_EXE (
  echo [1/3] Downloading portable Node.js runtime ^(node.exe^)...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://nodejs.org/dist/v22.14.0/win-x64/node.exe' -OutFile '%BIN_DIR%\node.exe'"
  if exist "%BIN_DIR%\node.exe" set "NODE_EXE=%BIN_DIR%\node.exe"
)

if not defined NODE_EXE (
  echo [ERROR] Could not find or download node.exe. Please check your internet connection.
  pause
  exit /b 1
)

:: 2. Locate or automatically download yt-dlp.exe
if not exist "%BIN_DIR%\yt-dlp.exe" (
  if exist "native_host\bin\yt-dlp.exe" (
    copy /Y "native_host\bin\yt-dlp.exe" "%BIN_DIR%\yt-dlp.exe" >nul
  ) else (
    echo [2/3] Downloading latest yt-dlp.exe...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
      "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe' -OutFile '%BIN_DIR%\yt-dlp.exe'"
  )
)

:: 3. Locate or automatically install FFmpeg (ffmpeg.exe)
set "FFMPEG_FOUND=0"
if exist "%BIN_DIR%\ffmpeg.exe" set "FFMPEG_FOUND=1"
if exist "native_host\bin\ffmpeg.exe" set "FFMPEG_FOUND=1"
where ffmpeg >nul 2>nul
if %ERRORLEVEL% EQU 0 set "FFMPEG_FOUND=1"

if "%FFMPEG_FOUND%"=="0" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$wg = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Packages'; if (Test-Path $wg) { $f = Get-ChildItem -Path $wg -Filter 'ffmpeg.exe' -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1; if ($f) { Copy-Item $f.FullName '%BIN_DIR%\ffmpeg.exe' -Force } }"
  if exist "%BIN_DIR%\ffmpeg.exe" set "FFMPEG_FOUND=1"
)

if "%FFMPEG_FOUND%"=="0" (
  echo [3/3] Downloading portable FFmpeg ^(ffmpeg.exe^)...
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12; $zip = Join-Path $env:TEMP 'ffmpeg_portable.zip'; $ext = Join-Path $env:TEMP 'ffmpeg_portable_ext'; Invoke-WebRequest -Uri 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip' -OutFile $zip; if (Test-Path $ext) { Remove-Item $ext -Recurse -Force }; Expand-Archive -Path $zip -DestinationPath $ext -Force; $exe = Get-ChildItem -Path $ext -Filter 'ffmpeg.exe' -Recurse | Select-Object -First 1; if ($exe) { Copy-Item $exe.FullName '%BIN_DIR%\ffmpeg.exe' -Force }; Remove-Item $zip -Force -ErrorAction SilentlyContinue; Remove-Item $ext -Recurse -Force -ErrorAction SilentlyContinue"
)

echo.
"%NODE_EXE%" "native_host\register.js" %1
echo.
pause
