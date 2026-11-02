@echo off
REM 火宝短剧 本地启动脚本（单服务模式：后端 5679 同时托管前端 dist）
cd /d "%~dp0backend"
set HTTP_PROXY=
set HTTPS_PROXY=
npm start
