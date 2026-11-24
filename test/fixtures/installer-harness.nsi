; A stand-in installer for test/installer.test.cjs: it includes the real build/installer.nsh and runs the same hooks
; electron-builder runs, with stand-ins for the few variables the template provides. Compiled with
;   makensis -WX /DOUT_FILE=... /DPLUGINS=... /DINSTALLER_NSH=... installer-harness.nsi
; Silent runs (/S) take their choices from the command line:
;   /CHOOSE=1|0   what ticking or leaving the "desktop shortcut" box would do (a silent install shows no page)
;   /REMOVE=1     run the uninstall hook instead; /KEEP=1 with it stands for "keep shortcuts" (an upgrade)

Unicode true
RequestExecutionLevel user
!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!insertmacro GetParameters
!insertmacro GetOptions

!define PRODUCT_NAME "GitGui"
!define SHORTCUT_NAME "GitGui Installer Test"
!define APP_ID "com.gitgui.installertest"
!define APP_DESCRIPTION "installer test"
!define isKeepShortcuts "$keepShortcuts == 1"

Var appExe
Var newDesktopLink
Var oldDesktopLink
Var keepShortcuts

Name "Installer test"
OutFile "${OUT_FILE}"
InstallDir "$TEMP\gitgui-installer-test"
!addplugindir "${PLUGINS}"
!include "${INSTALLER_NSH}"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"

Function .onInit
  StrCpy $appExe "$WINDIR\notepad.exe"
  StrCpy $newDesktopLink "$DESKTOP\${SHORTCUT_NAME}.lnk"
  StrCpy $oldDesktopLink "$DESKTOP\${SHORTCUT_NAME}.lnk"
  StrCpy $keepShortcuts "0"
  !insertmacro customInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/CHOOSE=" $R1
  ${IfNot} ${Errors}
    StrCpy $gitguiDesktopShortcut $R1
  ${EndIf}
  ClearErrors
  ${GetOptions} $R0 "/REMOVE=" $R1
  ${IfNot} ${Errors}
    ClearErrors
    ${GetOptions} $R0 "/KEEP=" $R2
    ${IfNot} ${Errors}
      StrCpy $keepShortcuts $R2
    ${EndIf}
    !insertmacro customUnInstall
    SetErrorLevel 0
    Quit
  ${EndIf}
FunctionEnd

Section
  SetOutPath $INSTDIR
  ; say what the install step saw, so a test can tell "not chosen" from "never ran"
  FileOpen $R8 "$TEMP\gitgui-installer-harness.log" w
  FileWrite $R8 "install step ran; desktop shortcut chosen = $gitguiDesktopShortcut"
  FileClose $R8
  !insertmacro customInstall
SectionEnd
