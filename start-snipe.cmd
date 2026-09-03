@echo off
rem bodkin snipe: the sniper in dry run, min score 55. Nothing is bought until you start it with --live from a terminal. Ctrl+C or close the window to stop.
cd /d "%~dp0"
if not exist node_modules (echo installing dependencies... && call npm install)
if not exist .env copy .env.example .env >nul
npx tsx src/cli.ts snipe --min-score 55
