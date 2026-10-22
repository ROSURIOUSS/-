@echo off
chcp 65001 >nul
setlocal EnableExtensions DisableDelayedExpansion
title Сборка Loria.exe
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 goto no_npm

echo.
echo   Ставлю инструменты сборки: esbuild, postject, resedit...
echo.
call npm install --no-fund --no-audit
if errorlevel 1 goto failed

echo.
echo   Собираю release\Loria.exe.
echo   Первый раз скачивается node.exe (~100 МБ), это может занять минуту.
echo.
call npm run build:exe
if errorlevel 1 goto failed

echo.
echo   Готово: release\Loria.exe
echo   Запуск: двойной клик или Лория.bat --exe
echo.
pause
exit /b 0

:no_npm
echo.
echo   Не найден Node.js/npm. Установи Node.js LTS: https://nodejs.org/ru
echo   Потом запусти этот файл снова.
echo.
pause
exit /b 1

:failed
echo.
echo   Сборка не удалась — текст ошибки выше.
echo.
pause
exit /b 1
