; Additions to GitGui's setup. electron-builder picks this file up from build/installer.nsh.
;
; The desktop shortcut is a choice, and off by default. package.json sets nsis.createDesktopShortcut to false, so
; electron-builder neither creates nor removes it, and this file does both: a wizard page with a checkbox after the
; installation folder, the shortcut itself, and its removal when GitGui is uninstalled.
;
; When a desktop shortcut already exists (Setup is run again to update), the box starts ticked, so an update does not
; take away a shortcut the user has. Setup removes the old version, shortcut included, before it installs the new one,
; so whether there was one is noted first (customInit). A silent install (/S) shows no page and follows the same default.

!ifndef BUILD_UNINSTALLER
  Var gitguiDesktopShortcut ; "1" when the desktop shortcut is to be created
  Var gitguiDesktopBox ; the checkbox on the page
!endif

!macro customInit
  !ifndef BUILD_UNINSTALLER
    StrCpy $gitguiDesktopShortcut "0"
    ${If} ${FileExists} "$DESKTOP\${SHORTCUT_NAME}.lnk"
      StrCpy $gitguiDesktopShortcut "1"
    ${EndIf}
  !endif
!macroend

; The page goes after the installation folder and before the files are copied. The functions are defined here, not
; above, because this macro is expanded once the wizard's own macros exist.
!macro customPageAfterChangeDir
  !include "nsDialogs.nsh"

  Page custom gitguiTasksPage gitguiTasksPageLeave

  Function gitguiTasksPage
    !insertmacro MUI_HEADER_TEXT "Additional tasks" "Choose what else Setup should do."
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 24u "Select the additional tasks you would like Setup to perform while installing ${PRODUCT_NAME}, then click Install."
    Pop $0
    ${NSD_CreateCheckbox} 0 34u 100% 12u "Create a &desktop shortcut"
    Pop $gitguiDesktopBox
    ${If} $gitguiDesktopShortcut == "1"
      ${NSD_Check} $gitguiDesktopBox
    ${EndIf}
    nsDialogs::Show
  FunctionEnd

  Function gitguiTasksPageLeave
    ${NSD_GetState} $gitguiDesktopBox $0
    ${If} $0 == ${BST_CHECKED}
      StrCpy $gitguiDesktopShortcut "1"
    ${Else}
      StrCpy $gitguiDesktopShortcut "0"
    ${EndIf}
  FunctionEnd
!macroend

!macro customInstall
  !ifndef BUILD_UNINSTALLER
    ${If} $gitguiDesktopShortcut == "1"
      CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
      ClearErrors
      WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${EndIf}
  !endif
!macroend

; electron-builder no longer knows about the desktop shortcut, so it would be left behind: remove it here (unless
; Setup is only replacing the old version and has been asked to keep shortcuts)
!macro customUnInstall
  ${ifNot} ${isKeepShortcuts}
    WinShell::UninstShortcut "$oldDesktopLink"
    Delete "$oldDesktopLink"
  ${endIf}
!macroend
