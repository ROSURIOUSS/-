@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
title Лория
cd /d "%~dp0"
set "EXE="

rem Логика: --exe — сразу собранный Loria.exe; иначе пробуем Node.js,
rem а если Node нет — запускаем Loria.exe, если он лежит рядом.

if /i "%~1"=="--exe" goto pick_exe

where node >nul 2>nul
if errorlevel 1 goto pick_exe

set "NODE_MAJOR="
for /f "tokens=1 delims=." %%v in ('node -v 2^>nul') do set "NODE_MAJOR=%%v"
if defined NODE_MAJOR set "NODE_MAJOR=%NODE_MAJOR:v=%"
if not defined NODE_MAJOR goto start_node
if %NODE_MAJOR% LSS 18 goto old_node

:start_node
echo.
echo   Запускаю Лорию — откроется собственное окно игры.
echo   Это служебное окно; закрывать его нельзя.
echo.
node scripts\launcher.js %*
set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" goto failed
exit /b 0

:pick_exe
if defined EXE goto start_exe
set "EXE=%~dp0Loria.exe"
if exist "%EXE%" goto start_exe
set "EXE=%~dp0release\Loria.exe"
if exist "%EXE%" goto start_exe
goto no_node

:start_exe
echo.
echo   Запускаю %EXE%
set "PROMPT="
start "" "%EXE%"
exit /b 0

:no_node
echo.
echo   Не нашёл ни Node.js 18+, ни Loria.exe рядом.
echo.
echo   Вариант 1. Установи Node.js LTS: https://nodejs.org/ru
echo              и снова запусти этот файл.
echo   Вариант 2. Положи Loria.exe рядом с этим файлом (или в папку release)
echo              и запусти снова.
echo.
start "" "https://nodejs.org/ru"
pause
exit /b 1

:old_node
if exist "%~dp0Loria.exe" goto pick_exe
if exist "%~dp0release\Loria.exe" goto pick_exe
echo.
echo   Node.js слишком старый: нужен 18 или новее.
echo   Обнови его: https://nodejs.org/ru
echo   Или запусти Лория.bat --exe, если рядом есть Loria.exe.
echo.
pause
exit /b 1

:failed
echo.
echo   Игра завершилась с кодом %CODE%. Если это ошибка — её текст выше.
echo.
pause
exit /b %CODE%
