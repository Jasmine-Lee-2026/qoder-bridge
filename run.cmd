@echo off
rem Standalone Qoder bridge: OpenAI-compatible API on 127.0.0.1:9528
rem Token lives in %USERPROFILE%\.qoder-bridge\auth.json (independent of cliproxy).
cd /d "%~dp0"
node src\index.js
