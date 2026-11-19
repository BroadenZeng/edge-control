@echo off
rem Start the persistent CDP bridge (one connection, so the browser asks for
rem debugging consent once instead of on every tool call).
rem Ports: CDP 9222 (browser), HTTP 9333 (bridge). Override with env vars.
setlocal
set "KIT=%~dp0"
if not defined MCP_HTTP_PORT set "MCP_HTTP_PORT=9333"
cd /d "%KIT%"
powershell.exe -NoProfile -File "%KIT%check-node.ps1"
if errorlevel 1 (
  pause
  exit /b 1
)
echo [bridge] kit=%KIT%
echo [bridge] http=%MCP_HTTP_PORT%
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js was installed. Please close and reopen this window, then try again.
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 (
  echo Please close and reopen this window to use the updated Node.js, then try again.
  pause
  exit /b 1
)
node "%KIT%mcp-edge-server.mjs" --http %MCP_HTTP_PORT% >> "%KIT%bridge.log" 2>&1
endlocal

