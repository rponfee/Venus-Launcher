; Al desinstalar de verdad (no al actualizar) se quita el protocolo venus:// que registra modules/deeplink.js.
; Si otra copia lo vuelve a necesitar, lo registra sola al abrir.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\venus"
  ${endIf}
!macroend
