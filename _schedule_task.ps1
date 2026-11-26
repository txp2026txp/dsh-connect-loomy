$ErrorActionPreference = 'Stop'
$name = 'dsh-loomy-market-submit'
$action = New-ScheduledTaskAction -Execute 'D:\Users\dsh-connect-loomy\scripts\submit-market.cmd'
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date '2026-11-27 13:20')
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Force | Out-Null
$t = Get-ScheduledTask -TaskName $name
$i = Get-ScheduledTaskInfo -TaskName $name
Write-Output ("TaskName=" + $t.TaskName)
Write-Output ("State=" + $t.State)
Write-Output ("NextRun=" + $i.NextRunTime)
Write-Output ("Action=" + $t.Actions[0].Execute)
