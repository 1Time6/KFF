param([ValidateSet('Start','Status','Stop','Recover')][string]$Action='Status',[switch]$Open)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $taskRoot
$taskNode=(Get-Command node -ErrorAction Stop).Source
function Read-RuntimeStatus {
    $taskResult=& $taskNode --import tsx scripts/local-runtime.ts status
    if(-not $taskResult){throw '无法读取本地运行状态'}
    return ($taskResult | Select-Object -Last 1 | ConvertFrom-Json)
}
$taskState=Read-RuntimeStatus
if($Action -eq 'Recover'){
    & $taskNode --import tsx scripts/local-runtime.ts recover
    if($LASTEXITCODE -ne 0){throw '恢复请求未送达。请查看状态；若原宿主已退出，使用启动入口。'}
    $taskDeadline=[DateTime]::UtcNow.AddSeconds(75)
    do{Start-Sleep -Milliseconds 750;$taskState=Read-RuntimeStatus;if($taskState.phase -in @('RUNNING','STOPPED','DEGRADED','STOP_BLOCKED','CONTROL_UNAVAILABLE')){break}}while([DateTime]::UtcNow -lt $taskDeadline)
    if($taskState.phase -in @('RUNNING','STOPPED')){Write-Output '恢复处理已完成。'}else{Write-Output "恢复尚未完成：$($taskState.phase)。保留原进程和日志，请查看状态。"}
    $taskState|ConvertTo-Json -Depth 6
    return
}
if($Action -eq 'Start'){
    if($taskState.phase -eq 'RUNNING'){
        Write-Output 'KFF 已在运行，沿用当前进程。'
    }else{
        if($taskState.phase -notin @('NOT_RUNNING','STOPPED')){throw "当前状态为 $($taskState.phase)，请先检查状态和原日志，不重复启动。"}
        $taskLogDirectory=Join-Path $taskRoot '.kff\local-runtime'
        New-Item -ItemType Directory -Path $taskLogDirectory -Force | Out-Null
        # The host is launched through the tracked Node launcher instead of Start-Process. On Windows
        # Start-Process builds a case-insensitive child environment, so an environment carrying both
        # `NO_PROXY` and `no_proxy` failed with "Item has already been added" and the host never
        # started; the recovery used to be a private script under the gitignored .kff directory.
        # Node hands the child an environment block it has already de-duplicated, so this entry works
        # on a clean checkout. Ownership, the duplicate-start guard and the log directory stay here.
        $taskLaunch=& $taskNode 'scripts/relaunch-local-runtime.mjs' $taskRoot $taskLogDirectory
        if($LASTEXITCODE -ne 0 -or -not $taskLaunch){throw '启动进程未能创建，请查看 .kff/local-runtime 下本次启动日志。'}
        $taskLauncher=$taskLaunch | Select-Object -Last 1 | ConvertFrom-Json
        $taskDeadline=[DateTime]::UtcNow.AddSeconds(75)
        do{
            Start-Sleep -Milliseconds 1000
            $taskState=Read-RuntimeStatus
            if($taskState.phase -in @('RUNNING','START_FAILED','DEGRADED','STOP_BLOCKED')){break}
            if(-not (Get-Process -Id $taskLauncher.launched_pid -ErrorAction SilentlyContinue)){throw '启动进程已退出，请查看 .kff/local-runtime 下本次启动日志。'}
        }while([DateTime]::UtcNow -lt $taskDeadline)
        if($taskState.phase -ne 'RUNNING'){throw "启动仍未就绪，当前状态：$($taskState.phase)。保留原进程，请查看状态后继续处理。"}
        Write-Output 'KFF 工作台、Worker 和 Agent 已启动。'
    }
    if($Open){Start-Process -FilePath 'http://127.0.0.1:3000/acquisition'}
}elseif($Action -eq 'Stop'){
    if($taskState.phase -in @('NOT_RUNNING','STOPPED')){Write-Output 'KFF 本地宿主未运行。';return}
    & $taskNode --import tsx scripts/local-runtime.ts stop
    $taskDeadline=[DateTime]::UtcNow.AddSeconds(45)
    do{Start-Sleep -Milliseconds 1000;$taskState=Read-RuntimeStatus;if($taskState.phase -in @('STOPPED','STOP_BLOCKED','NOT_RUNNING')){break}}while([DateTime]::UtcNow -lt $taskDeadline)
    if($taskState.phase -ne 'STOPPED'){Write-Output "仍在等待已接单任务、回执或关闭证明：$($taskState.phase)。不强杀浏览器；请继续查看运行状态。"}
}
$taskState|ConvertTo-Json -Depth 6
