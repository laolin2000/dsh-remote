' ===========================================================================
' phone-link-hidden.vbs - launch phone-link.cmd without a console window
' Keep this file ASCII-only (cmd/wscript encoding safety).
' Optional args are forwarded, e.g.:  wscript phone-link-hidden.vbs --role readonly
' ===========================================================================
Option Explicit
Dim sh, fso, here, args, i, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " " & WScript.Arguments(i)
Next
cmd = """" & here & "\phone-link.cmd""" & args
sh.Run cmd, 0, False
