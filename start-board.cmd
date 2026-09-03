@echo off
rem bodkin board: starts the engine in dry run and opens the page. Close this window to stop.
cd /d "%~dp0"
if not exist node_modules (echo installing dependencies... && call npm install)
if not exist .env copy .env.example .env >nul
start "" http://127.0.0.1:4663
npx tsx src/cli.ts board --min-score 55
