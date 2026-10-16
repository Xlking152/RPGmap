; UserData is outside $INSTDIR and must never be passed to RemoveFiles or RMDir.
!include "TextFunc.nsh"
!include "StrFunc.nsh"
!macro customCheckAppRunning
  ; Request shutdown through Electron's single-instance channel. Never kill the
  ; runtime: persistence must finish before either replacement or uninstall.
  ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R8
  ${If} $R8 == 0
    IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 rpgmap_close_failed
    nsExec::Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --rpgmap-exit-existing'
    Pop $R9
    StrCpy $R9 0
    rpgmap_wait_close:
      Sleep 250
      ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R8
      StrCmp $R8 0 0 rpgmap_close_complete
      IntOp $R9 $R9 + 1
      IntCmp $R9 120 rpgmap_close_failed rpgmap_wait_close rpgmap_close_failed
    rpgmap_close_failed:
      MessageBox MB_OK|MB_ICONEXCLAMATION "RPGmap has not finished saving. Close RPGmap normally, then run this installer again." /SD IDOK
      Abort "RPGmap is still running. Program files have not been replaced."
    rpgmap_close_complete:
  ${EndIf}
!macroend
!ifdef BUILD_UNINSTALLER
  ${UnStrStr}
  Var /GLOBAL rpgmapRecoveryDir
!endif
!macro customInit
  ; Stable per-user application identity; the normal NSIS upgrade lifecycle
  ; invokes the previous uninstaller before replacing program-owned resources.
!macroend

!macro customUnInstall
  ; Preserve %LOCALAPPDATA%\RPGmap\UserData, packages, worlds, uploads and backups.
!macroend

; Delete only files installed by this program. Unrelated files and directories
; added under the installation directory are preserved. During an upgrade,
; retain a previous-program copy outside UserData for explicit recovery.
!macro customRemoveFiles
  IfFileExists "$INSTDIR\resources\PROGRAM-FILES.txt" 0 rpgmap_manifest_missing
  ClearErrors
  FileOpen $R0 "$INSTDIR\resources\PROGRAM-FILES.txt" r
  IfErrors rpgmap_preserve_failed
  StrCpy $R5 "delete"
  ${If} ${isUpdated}
    StrCpy $R5 "copy"
    ${GetTime} "" "L" $0 $1 $2 $3 $4 $5 $6
    StrCpy $rpgmapRecoveryDir "$LOCALAPPDATA\RPGmap\ProgramRecovery\${VERSION}-$2$1$0-$4$5$6"
    ClearErrors
    CreateDirectory "$rpgmapRecoveryDir"
    CopyFiles /SILENT "$INSTDIR\resources\PROGRAM-FILES.txt" "$rpgmapRecoveryDir\PROGRAM-FILES.txt"
    IfErrors rpgmap_preserve_failed
    FileOpen $R4 "$rpgmapRecoveryDir\INSTALL-DIRECTORY.txt" w
    IfErrors rpgmap_preserve_failed
    FileWrite $R4 "$INSTDIR$\r$\n"
    FileClose $R4
    IfErrors rpgmap_preserve_failed
  ${EndIf}
  rpgmap_manifest_loop:
    ClearErrors
    FileRead $R0 $R1
    IfErrors rpgmap_manifest_done
    ${TrimNewLines} $R1 $R1
    StrCmp $R1 "" rpgmap_manifest_loop
    StrCmp $R1 "resources\PROGRAM-FILES.txt" rpgmap_manifest_loop
    GetFullPathName $R2 "$INSTDIR\$R1"
    ${UnStrStr} $R3 "$R2" "$INSTDIR\"
    StrCmp $R3 $R2 0 rpgmap_manifest_loop
    ${If} $R5 == "copy"
      ${GetParent} "$rpgmapRecoveryDir\$R1" $R3
      CreateDirectory "$R3"
      ClearErrors
      CopyFiles /SILENT "$R2" "$rpgmapRecoveryDir\$R1"
      ${If} ${Errors}
        FileClose $R0
        Abort "Cannot preserve the previous RPGmap program: $R2"
      ${EndIf}
    ${Else}
      Delete "$R2"
    ${EndIf}
    Goto rpgmap_manifest_loop
  rpgmap_manifest_done:
    ${If} $R5 == "copy"
      StrCpy $R5 "delete"
      FileSeek $R0 0 SET
      Goto rpgmap_manifest_loop
    ${EndIf}
    FileClose $R0
    Delete "$INSTDIR\resources\PROGRAM-FILES.txt"
    Delete "$INSTDIR\${UNINSTALL_FILENAME}"
    RMDir "$INSTDIR\resources\app\assets"
    RMDir "$INSTDIR\resources\app"
    RMDir "$INSTDIR\resources\server"
    RMDir "$INSTDIR\resources"
    RMDir "$INSTDIR\locales"
    RMDir "$INSTDIR"
    Goto rpgmap_remove_done
  rpgmap_preserve_failed:
    FileClose $R0
    Abort "Cannot read or preserve the previous RPGmap program. Existing program files have not been removed."
  rpgmap_manifest_missing:
    ; No old manifest means no broad deletion. A pre-v3 installation is not
    ; silently treated as disposable program state.
    DetailPrint "RPGmap program manifest missing; existing files preserved."
  rpgmap_remove_done:
!macroend
