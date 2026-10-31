$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot
python -m pip install -r requirements.txt -q
Write-Host "TradeTwin 已启动：http://127.0.0.1:8000"
python -m uvicorn tradetwin.server:app --host 127.0.0.1 --port 8000
