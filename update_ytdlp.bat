@echo off
cd /d "%~dp0"
echo Updating yt-dlp to the latest version (for YouTube, VK, etc.)...
if exist "native_host\bin\yt-dlp.exe" (
  "native_host\bin\yt-dlp.exe" -U
)
if exist "C:\Users\Public\HellDownloader\bin\yt-dlp.exe" (
  copy /Y "native_host\bin\yt-dlp.exe" "C:\Users\Public\HellDownloader\bin\yt-dlp.exe" >nul
)
echo.
echo Done!
pause
