# dsh-remote — Windows 计划任务模板
# 以当前用户身份开机自启守卫（无窗口）。先改下面的三个路径/参数再运行：
#   powershell -ExecutionPolicy Bypass -File install-guard-task.ps1

$Node     = "node.exe"                      # 或写 node 的绝对路径
$Guard    = "$HOME\dsh-remote\guard\guard.mjs"
$TaskName = "dsh-remote-guard"
$WorkDir  = Split-Path $Guard

$action    = New-ScheduledTaskAction -Execute $Node -Argument "`"$Guard`" serve" -WorkingDirectory $WorkDir
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings  = New-ScheduledTaskSettingsSet -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) `
             -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Force

Write-Host "已注册计划任务 $TaskName。立即启动： Start-ScheduledTask -TaskName $TaskName"
Write-Host "查看链接： node `"$Guard`" pair"
