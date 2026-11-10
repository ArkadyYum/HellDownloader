@echo off
cd /d "%~dp0"
echo Packaging HellDownloader into HellDownloader_Setup.zip...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = (Get-Location).Path; " ^
  "$stage = Join-Path $env:TEMP 'HellDownloader_Package_Stage'; " ^
  "$zip = Join-Path $root 'HellDownloader_Setup.zip'; " ^
  "if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }; " ^
  "if (Test-Path $zip) { Remove-Item $zip -Force }; " ^
  "New-Item -ItemType Directory -Path (Join-Path $stage 'HellDownloader\extension') -Force | Out-Null; " ^
  "New-Item -ItemType Directory -Path (Join-Path $stage 'HellDownloader\native_host\bin') -Force | Out-Null; " ^
  "New-Item -ItemType Directory -Path (Join-Path $stage 'HellDownloader\docs') -Force | Out-Null; " ^
  "Copy-Item (Join-Path $root 'extension\*') (Join-Path $stage 'HellDownloader\extension') -Recurse -Force; " ^
  "Copy-Item (Join-Path $root 'native_host\host.js') (Join-Path $stage 'HellDownloader\native_host\host.js') -Force; " ^
  "Copy-Item (Join-Path $root 'native_host\register.js') (Join-Path $stage 'HellDownloader\native_host\register.js') -Force; " ^
  "Copy-Item (Join-Path $root 'native_host\ext_key.json') (Join-Path $stage 'HellDownloader\native_host\ext_key.json') -Force; " ^
  "if (Test-Path (Join-Path $root 'docs\*')) { Copy-Item (Join-Path $root 'docs\*') (Join-Path $stage 'HellDownloader\docs') -Recurse -Force }; " ^
  "Copy-Item (Join-Path $root 'install.bat') (Join-Path $stage 'HellDownloader\install.bat') -Force; " ^
  "Copy-Item (Join-Path $root 'uninstall.bat') (Join-Path $stage 'HellDownloader\uninstall.bat') -Force; " ^
  "Copy-Item (Join-Path $root 'update_ytdlp.bat') (Join-Path $stage 'HellDownloader\update_ytdlp.bat') -Force; " ^
  "Copy-Item (Join-Path $root 'README.txt') (Join-Path $stage 'HellDownloader\README.txt') -Force; " ^
  "if (Test-Path (Join-Path $root 'README.md')) { Copy-Item (Join-Path $root 'README.md') (Join-Path $stage 'HellDownloader\README.md') -Force }; " ^
  "Compress-Archive -Path (Join-Path $stage 'HellDownloader') -DestinationPath $zip -Force; " ^
  "Remove-Item $stage -Recurse -Force; " ^
  "Write-Host 'Created:' $zip"
