; Al desinstalar (no al actualizar), quitar venus:// solo si todavía apunta a esta copia.
; Otra instalación o la portable pueden haber registrado el protocolo después.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    Push $R0
    ReadRegStr $R0 HKCU "Software\Classes\venus\shell\open\command" ""
    ${if} $R0 == '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
      DeleteRegKey HKCU "Software\Classes\venus"
    ${endIf}
    Pop $R0
  ${endIf}
!macroend
