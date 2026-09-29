' qoder-bridge silent stopper - kills exactly the PID recorded in run\proxy.pid,
' never a blanket taskkill, so unrelated node processes are safe.
Dim sh, fso
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

Dim home : home = "D:\qoder-bridge"
Dim pidFile : pidFile = home & "\run\proxy.pid"

If Not fso.FileExists(pidFile) Then
    MsgBox "qoder-bridge is not running (no pid file).", 64, "qoder-bridge"
    WScript.Quit
End If

Dim pid : pid = Trim(fso.OpenTextFile(pidFile, 1).ReadAll())
If Not IsNumeric(pid) Then
    fso.DeleteFile pidFile, True
    MsgBox "Stale pid file removed.", 48, "qoder-bridge"
    WScript.Quit
End If

' Verify the process is still alive before killing; then confirm it is gone.
Dim proc : Set proc = Nothing
On Error Resume Next
Set proc = GetObject("winmgmts:\\.\root\cimv2:Win32_Process.Handle='" & pid & "'")
On Error GoTo 0

If proc Is Nothing Then
    fso.DeleteFile pidFile, True
    MsgBox "qoder-bridge was not running (stale pid " & pid & " cleaned).", 64, "qoder-bridge"
    WScript.Quit
End If

Dim ret
ret = proc.Terminate()
fso.DeleteFile pidFile, True

If ret = 0 Then
    MsgBox "qoder-bridge stopped (pid " & pid & ").", 64, "qoder-bridge"
Else
    MsgBox "Failed to stop pid " & pid & " (exit " & ret & ").", 48, "qoder-bridge"
End If
