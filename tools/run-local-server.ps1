$ErrorActionPreference = "Stop"
$env:HOST = "0.0.0.0"
$env:PORT = "8080"
$env:NODE_NO_WARNINGS = "1"
Set-Location (Resolve-Path (Join-Path $PSScriptRoot ".."))
node --experimental-strip-types server/index.ts 1> build/local-v2-server.log 2> build/local-v2-server.err.log
