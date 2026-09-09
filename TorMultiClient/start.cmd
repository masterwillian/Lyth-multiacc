@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js nao foi encontrado no PATH.
    echo Instale o Node.js 18+ e tente novamente.
    pause
    exit /b 1
)

if not exist "%~dp0node_modules" (
    echo Dependencias nao encontradas. Instalando...
    call npm install
    if errorlevel 1 (
        echo Falha ao instalar as dependencias.
        pause
        exit /b 1
    )
)

echo Iniciando hub-bliw...
call npm start
exit /b %errorlevel%
