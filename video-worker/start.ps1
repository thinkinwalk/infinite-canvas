param([string]$BindHost = '127.0.0.1', [int]$Port = 8767)
$videoWorkerRoot = $PSScriptRoot
$videoPython = Join-Path $videoWorkerRoot '.venv/Scripts/python.exe'
if (!(Test-Path -LiteralPath $videoPython)) { throw '请先按 README 创建虚拟环境并安装 requirements-ai.txt' }
$videoLocalModel = Join-Path $videoWorkerRoot 'data/models/whisper-small'
if (!$env:WHISPER_MODEL -and (Test-Path -LiteralPath (Join-Path $videoLocalModel 'model.bin'))) { $env:WHISPER_MODEL = $videoLocalModel }
Set-Location -LiteralPath $videoWorkerRoot
& $videoPython -m uvicorn app:app --host $BindHost --port $Port
