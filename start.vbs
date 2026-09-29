' qoder-bridge silent launcher - no console window, runs in background.
' PID-file based state check (port check alone can be fooled by another
' process), stale PID cleanup, and a distinct message when the port is
' occupied by something else.
Dim sh, fso
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

Dim home : home = "D:\qoder-bridge"
sh.CurrentDirectory = home

Dim pidFile : pidFile = home & "\run\proxy.pid"

' --- Already running? -------------------------------------------------------
If fso.FileExists(pidFile) Then
    Dim oldPid : oldPid = Trim(fso.OpenTextFile(pidFile, 1).ReadAll())
    If IsNumeric(oldPid) Then
        Dim proc : Set proc = Nothing
        On Error Resume Next
        Set proc = GetObject("winmgmts:\\.\root\cimv2:Win32_Process.Handle='" & oldPid & "'")
        On Error GoTo 0
        If Not proc Is Nothing Then
            MsgBox "qoder-bridge is already running (pid " & oldPid & ")." & vbCrLf & _
                   "Control page: http://127.0.0.1:9528/", 64, "qoder-bridge"
            WScript.Quit
        End If
    End If
    fso.DeleteFile pidFile, True ' stale pid file, clean it up
End If

' --- Port 9528 occupied by someone else? -------------------------------------
Dim exec, out, occupied
Set exec = sh.Exec("netstat -ano")
out = exec.StdOut.ReadAll()
occupied = ""
Dim line, lines
lines = Split(out, vbCrLf)
For Each line In lines
    If InStr(line, "127.0.0.1:9528") > 0 And InStr(line, "LISTENING") > 0 Then
        Dim parts, i
        parts = Split(Trim(line), " ")
        For i = UBound(parts) To 0 Step -1
            If Len(parts(i)) > 0 Then occupied = parts(i) : Exit For
        Next
        Exit For
    End If
Next
If occupied <> "" Then
    MsgBox "Port 9528 is occupied by another process (pid " & occupied & ")." & vbCrLf & _
           "Stop it first or change PORT via the QODER_PORT environment variable.", 48, "qoder-bridge"
    WScript.Quit
End If

' --- Start hidden, then confirm the listener is up ---------------------------
If Not fso.FolderExists(home & "\run") Then fso.CreateFolder home & "\run"

sh.Run "cmd /c node src\index.js 1> run\proxy.out.log 2> run\proxy.err.log", 0, False
WScript.Sleep 1500

Set exec = sh.Exec("netstat -ano")
out = exec.StdOut.ReadAll()
Dim started : started = ""
lines = Split(out, vbCrLf)
For Each line In lines
    If InStr(line, "127.0.0.1:9528") > 0 And InStr(line, "LISTENING") > 0 Then
        parts = Split(Trim(line), " ")
        For i = UBound(parts) To 0 Step -1
            If Len(parts(i)) > 0 And IsNumeric(parts(i)) Then started = parts(i) : Exit For
        Next
        Exit For
    End If
Next

If started = "" Then
    MsgBox "Failed to start. Check run\proxy.err.log in D:\qoder-bridge.", 16, "qoder-bridge"
    WScript.Quit
End If

fso.CreateTextFile(pidFile, True).Write started
MsgBox "qoder-bridge started (pid " & started & ")" & vbCrLf & _
       "API        : http://127.0.0.1:9528/v1" & vbCrLf & _
       "Control    : http://127.0.0.1:9528/", 64, "qoder-bridge"
