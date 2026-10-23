#requires -Version 7.0
[CmdletBinding()]
param(
    [string]$BaseUrl = $env:VOICE_API_BASE_URL,
    [string]$AudioPath = $env:VOICE_REFERENCE_FILE,
    [string]$Name = "个人音色",
    [string]$ReferenceText = $env:VOICE_REFERENCE_TEXT,
    [string]$Text = $env:VOICE_SYNTHESIS_TEXT,
    [string]$Language = "Chinese",
    [string]$VoiceId = $env:VOICE_ID,
    [string]$OutputPath = (Join-Path $PWD "speech-output.wav"),
    [switch]$CreateKey
)

$ErrorActionPreference = "Stop"
if (!$BaseUrl) { $BaseUrl = "https://studio.lingzhouai.com" }
$BaseUrl = $BaseUrl.TrimEnd("/")
$address = [uri]$BaseUrl
if ($address.Scheme -ne "https" -and !$address.IsLoopback) { throw "外部客户端必须使用 HTTPS。" }

function Invoke-VoiceJson {
    param([string]$Method, [string]$Path, $Body, [hashtable]$ExtraHeaders = @{})
    $headers = @{ Authorization = "Bearer $env:VOICE_API_KEY" }
    foreach ($entry in $ExtraHeaders.GetEnumerator()) { $headers[$entry.Key] = $entry.Value }
    $arguments = @{ Method = $Method; Uri = "$BaseUrl$Path"; Headers = $headers }
    if ($null -ne $Body) {
        $arguments.ContentType = "application/json; charset=utf-8"
        $arguments.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 10 -Compress))
    }
    $response = Invoke-RestMethod @arguments
    if ($response.code -ne 0) { throw $response.msg }
    return $response.data
}

if ($CreateKey) {
    if (!$env:VOICE_LOGIN_TOKEN) { throw "创建 Key 需要环境变量 VOICE_LOGIN_TOKEN（普通用户登录令牌）。" }
    $body = [Text.Encoding]::UTF8.GetBytes((@{ name = "微信语音工作台" } | ConvertTo-Json -Compress))
    $response = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/client-api-keys" -Headers @{ Authorization = "Bearer $env:VOICE_LOGIN_TOKEN" } -ContentType "application/json; charset=utf-8" -Body $body
    if ($response.code -ne 0) { throw $response.msg }
    $env:VOICE_API_KEY = $response.data.api_key
    Write-Host "客户端 Key 已写入当前进程环境变量，不输出密钥。"
}
if (!$env:VOICE_API_KEY) { throw "请设置 VOICE_API_KEY。" }
if (!$Text) { throw "请设置 VOICE_SYNTHESIS_TEXT。" }
if (!$env:VOICE_IDEMPOTENCY_KEY) { throw "请设置 VOICE_IDEMPOTENCY_KEY；同一次生成的重试必须保留此值与 VOICE_ID。" }

if (!$VoiceId) {
    if (!$AudioPath -or !$ReferenceText) { throw "新建音色需要 VOICE_REFERENCE_FILE 和 VOICE_REFERENCE_TEXT。" }
    $form = @{ name = $Name; file = Get-Item -LiteralPath $AudioPath; reference_text = $ReferenceText; language = $Language }
    $response = Invoke-RestMethod -Method Post -Uri "$BaseUrl/api/v1/voices" -Headers @{ Authorization = "Bearer $env:VOICE_API_KEY" } -Form $form
    if ($response.code -ne 0) { throw $response.msg }
    $VoiceId = $response.data.voice_id
    Write-Host "已保存音色：$VoiceId"
    Write-Host "重试请设置 VOICE_ID=$VoiceId，避免重复上传后产生幂等冲突。"
}
$voices = Invoke-VoiceJson -Method GET -Path "/api/v1/voices?page=1&page_size=20"
Write-Host "当前账号音色数：$($voices.total)"
$request = @{ voice_id = $VoiceId; text = $Text; language = $Language }
$quote = Invoke-VoiceJson -Method POST -Path "/api/v1/speech/quote" -Body $request
Write-Host "本次报价：$($quote.credits) 点；余额：$($quote.balance) 点；$($quote.calculation)"
if (!$quote.sufficient_balance) { throw "算力点不足。" }
$request.expected_credits = $quote.credits
$task = Invoke-VoiceJson -Method POST -Path "/api/v1/speech/tasks" -Body $request -ExtraHeaders @{ "Idempotency-Key" = $env:VOICE_IDEMPOTENCY_KEY }
Write-Host "任务：$($task.task_id)"
while ($task.status -in @("creating", "running", "generated")) {
    Start-Sleep -Seconds 2
    $task = Invoke-VoiceJson -Method GET -Path "/api/v1/speech/tasks/$($task.task_id)"
    Write-Host "状态：$($task.status)"
}
if ($task.status -ne "completed") { throw "$($task.error.code)：$($task.error.message)" }
if (!$task.audio.url.StartsWith("/api/v1/speech/tasks/")) { throw "下载路径无效。" }
$actualExtension = ".$($task.audio.format)"
$OutputPath = [IO.Path]::ChangeExtension([IO.Path]::GetFullPath($OutputPath), $actualExtension)
Invoke-WebRequest -Uri "$BaseUrl$($task.audio.url)" -Headers @{ Authorization = "Bearer $env:VOICE_API_KEY" } -OutFile $OutputPath | Out-Null
$digest = (Get-FileHash -LiteralPath $OutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($digest -ne $task.audio.sha256) { throw "下载文件 SHA-256 校验失败。" }
[pscustomobject]@{ voice_id = $VoiceId; task_id = $task.task_id; status = $task.status; charged_credits = $task.charged_credits; mime_type = $task.audio.mime_type; duration_seconds = $task.audio.duration_seconds; sha256 = $digest; path = $OutputPath }
