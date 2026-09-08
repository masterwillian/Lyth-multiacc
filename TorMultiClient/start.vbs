Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

shell.CurrentDirectory = scriptDir
shell.Run "cmd /c start.cmd", 0, True
