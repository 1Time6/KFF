# Launch the installed manager with a direct connection to its own control API.
# This does not edit Windows proxy settings or any AdsPower profile proxy.
$ErrorActionPreference = 'Stop'
$executable = 'C:\Program Files\AdsPower Global\AdsPower Global.exe'
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) { throw '未找到已安装的 AdsPower Global' }
$running = @(Get-Process -Name 'AdsPower Global' -ErrorAction SilentlyContinue)
if ($running.Count) {
    Write-Output 'AdsPower 已在运行；未重启或改动现有进程。'
    return
}
$taskLogDirectory = Join-Path (Split-Path -Parent $PSScriptRoot) '.kff\adspower-manager'
New-Item -ItemType Directory -Path $taskLogDirectory -Force | Out-Null
$taskStamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfff')
$taskOriginalNoProxy = $env:NO_PROXY
try {
    # Older AdsPower Axios misroutes HTTPS_PROXY requests. Scope the direct
    # control-server exception to this manager process only.
    $env:NO_PROXY = (@($taskOriginalNoProxy, 'api-global.adspower.net') | Where-Object { $_ }) -join ','
    # Persistent output handles prevent Electron EPIPE when this launcher exits.
    $process = Start-Process -FilePath $executable -WorkingDirectory ([System.IO.Path]::GetDirectoryName($executable)) -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $taskLogDirectory "$taskStamp.stdout.log") -RedirectStandardError (Join-Path $taskLogDirectory "$taskStamp.stderr.log")
} finally {
    $env:NO_PROXY = $taskOriginalNoProxy
}
if ($null -eq $process) { throw 'AdsPower 启动失败' }
@{ started_at = [DateTime]::UtcNow.ToString('o'); pid = $process.Id; executable = $executable; process_only_no_proxy_added = 'api-global.adspower.net'; stdout = "$taskStamp.stdout.log"; stderr = "$taskStamp.stderr.log" } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $taskLogDirectory "$taskStamp.start.json") -Encoding UTF8
Write-Output ('AdsPower 管理程序已启动，PID：' + $process.Id)
Write-Output '启动完成后可由 KFF 读取指定环境；账号环境中的代理配置保持原样。'
