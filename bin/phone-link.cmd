@echo off
rem ===========================================================================
rem phone-link.cmd — 桌面快捷键调用入口（保持 ASCII，避免 cmd 编码问题）
rem 真正的逻辑在 phone-link.mjs（Node，UTF-8 安全）
rem ===========================================================================
setlocal
set "NODE_EXE="
for %%P in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:P"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE (
  echo node.exe not found. Install Node.js or edit this file. & pause & exit /b 1
)
"%NODE_EXE%" "%~dp0phone-link.mjs" %*
endlocal
