@echo off
setlocal
chcp 65001 >nul

set "CHOICEMIND_ROOT=%~dp0"
set "CHOICEMIND_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
echo ChoiceMind 启动文件：%CHOICEMIND_ROOT%start_all.bat

if not exist "%CHOICEMIND_POWERSHELL%" (
  echo 错误：找不到 Windows PowerShell，无法启动 ChoiceMind。 1>&2
  exit /b 1
)

"%CHOICEMIND_POWERSHELL%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%CHOICEMIND_ROOT%scripts\start-all\start-all.ps1" %*
set "CHOICEMIND_EXIT_CODE=%ERRORLEVEL%"
if not "%CHOICEMIND_START_ALL_NO_PAUSE%"=="1" "%CHOICEMIND_POWERSHELL%" -NoLogo -NoProfile -Command "if (-not [Console]::IsInputRedirected) { [void](Read-Host '按 Enter 键关闭此窗口') }"
exit /b %CHOICEMIND_EXIT_CODE%
