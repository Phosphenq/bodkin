@echo off
rem bodkin hunt: the live launch feed in this window. Ctrl+C or close the window to stop.
cd /d "%~dp0"
if not exist node_modules (echo installing dependencies... && call npm install)
if not exist .env copy .env.example .env >nul
npx tsx src/cli.ts hunt
