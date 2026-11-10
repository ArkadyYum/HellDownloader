@echo off
setlocal EnableDelayedExpansion
title HellDownloader — Uninstaller

echo ============================================================
echo   HellDownloader — Uninstaller
echo ============================================================
echo.

set "HOST_NAME=com.vibecoding.videoclipper"

echo [1/2] Removing Native Messaging Host registry keys...
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>nul
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>nul
reg delete "HKCU\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>nul
reg delete "HKCU\Software\Chromium\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>nul
reg delete "HKCU\Software\Yandex\YandexBrowser\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>nul
reg delete "HKCU\Software\Opera Software\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>nul
reg delete "HKCU\Software\Vivaldi\NativeMessagingHosts\%HOST_NAME%" /f >nul 2>nul

echo [2/2] Removing runtime files from C:\Users\Public\HellDownloader...
if exist "C:\Users\Public\HellDownloader" (
  rmdir /S /Q "C:\Users\Public\HellDownloader" >nul 2>nul
)
if exist "C:\Users\Public\DevilDownload" (
  rmdir /S /Q "C:\Users\Public\DevilDownload" >nul 2>nul
)

echo.
echo ============================================================
echo   HellDownloader local engine has been removed!
echo   To remove the extension icon from your browser:
echo   Open chrome://extensions/ and click "Remove" on HellDownloader.
echo ============================================================
echo.
pause
