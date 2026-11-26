@echo off
setlocal
cd /d D:\Users\dsh-connect-loomy
set /p GHT=<.token.txt
set GITHUB_TOKEN=%GHT%
"C:\Users\1\.workbuddy\binaries\node\versions\24.20.0\node.exe" scripts\publish.mjs market >> _market-submit.log 2>&1
echo EXIT=%ERRORLEVEL% >> _market-submit.log
endlocal
