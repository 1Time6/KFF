param([Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_-]{1,100}$')][string]$ProfileId,[Parameter(Mandatory)][ValidateRange(1,2147483647)][int]$BrowserProcessId,[Parameter(Mandatory)][ValidateRange(1,65535)][int]$Port)
$ErrorActionPreference='Stop'
$taskBrowser=Get-CimInstance Win32_Process -Filter "ProcessId=$BrowserProcessId"
if(-not $taskBrowser -or $taskBrowser.Name -ne 'SunBrowser.exe' -or $taskBrowser.CommandLine -match '--type='){throw 'Expected original AdsPower browser process'}
$taskProfilePattern='\\\.ADSPOWER_GLOBAL\\cache\\'+[regex]::Escape($ProfileId)+'_[A-Za-z0-9]+(?:[""\s]|$)'
if($taskBrowser.CommandLine -notmatch $taskProfilePattern){throw 'Browser process belongs to another profile'}
$taskListeners=@(Get-NetTCPConnection -State Listen -LocalPort $Port | Select-Object -ExpandProperty OwningProcess -Unique)
if($taskListeners.Count -ne 1 -or $taskListeners[0] -ne $BrowserProcessId){throw 'Debug listener belongs to another process'}
@{pid=$BrowserProcessId;created_at=$taskBrowser.CreationDate.ToUniversalTime().ToString('o');profile_id=$ProfileId;debug_port=$Port;listener_matches=$true;executable=$taskBrowser.ExecutablePath}|ConvertTo-Json -Compress
