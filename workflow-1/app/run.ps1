param([ValidateSet("dev", "start")][string]$Mode = "dev")
$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "../..")).Path
Push-Location -LiteralPath $projectRoot
try {
    # The shared supervisor loads root .env, checks prerequisites, and owns cleanup.
    & node (Join-Path $projectRoot "scripts/workflows.mjs") $Mode
    exit $LASTEXITCODE
} finally {
    Pop-Location
}
