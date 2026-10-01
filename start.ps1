$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$taskNode = Get-Command node -ErrorAction SilentlyContinue
if ($taskNode) {
  $taskNodePath = $taskNode.Source
} else {
  $taskNodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
}
if (-not (Test-Path -LiteralPath $taskNodePath)) {
  Write-Host 'Node.js was not found. Install Node.js, then try again.'
  Read-Host 'Press Enter to close'
  exit 1
}
& $taskNodePath (Join-Path $PSScriptRoot 'server.mjs') --open
Read-Host 'Press Enter to close'
