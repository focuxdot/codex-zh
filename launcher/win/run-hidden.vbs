' Codex-叉叉 远程 daemon 隐藏启动器。
'
' 计划任务用交互式令牌（InteractiveToken）在用户会话里跑 daemon，好让 daemon 能拉起
' 桌面 Codex app-server。但 node.exe 是控制台程序，直接由计划任务启动会弹出一个黑色
' 控制台窗口（用户会看到）。这里用无窗口的 wscript 承载：以隐藏窗口方式启动 node，并
' **等待其退出**——这样：
'   1. 全程无可见窗口（对齐 macOS launchd 的无窗行为）；
'   2. wscript 存活期 == daemon 存活期，计划任务仍能跟踪进程、触发 RestartOnFailure 崩溃自愈；
'   3. node 退出码透传给计划任务（崩溃即非 0 → 触发重启）。
' daemon 自身在 win32 下会写 daemon.log，隐藏窗口不丢日志。
'
' 参数：0=node.exe 绝对路径  1=daemon main.mjs 绝对路径  2=工作目录（可选）
Option Explicit
Dim sh, node, main, workdir, cmd, rc
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 2 Then WScript.Quit 2
node = WScript.Arguments(0)
main = WScript.Arguments(1)
If WScript.Arguments.Count > 2 Then
  workdir = WScript.Arguments(2)
  If Len(workdir) > 0 Then sh.CurrentDirectory = workdir
End If
cmd = """" & node & """ """ & main & """ start"
rc = sh.Run(cmd, 0, True)  ' 0 = 隐藏窗口；True = 等待子进程退出并返回其退出码
WScript.Quit rc
