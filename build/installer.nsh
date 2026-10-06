; Registers Orivon with Windows as a web browser, so it is listed under "Default apps" and the person can
; choose it for http and https. Windows keeps that choice per user and does not let a program set it:
; the app opens Settings (src/main/os/default-browser-runner.ts) and the person picks.
;
; The names below are what a pinned shortcut and a default-app choice key on: renaming one costs the person
; their choice, so they are fixed. The `--` in the URL command ends the switches, so a link can
; never be read as one.

!define ORIVON_CLIENT_KEY "Software\Clients\StartMenuInternet\Orivon"
!define ORIVON_URL_CLASS "Software\Classes\OrivonURL"

!macro customInstall
  WriteRegStr SHCTX "${ORIVON_CLIENT_KEY}" "" "Orivon"
  WriteRegStr SHCTX "${ORIVON_CLIENT_KEY}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "${ORIVON_CLIENT_KEY}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegStr SHCTX "${ORIVON_CLIENT_KEY}\Capabilities" "ApplicationName" "Orivon"
  WriteRegStr SHCTX "${ORIVON_CLIENT_KEY}\Capabilities" "ApplicationDescription" "A browser that runs applications Chrome cannot"
  WriteRegStr SHCTX "${ORIVON_CLIENT_KEY}\Capabilities" "ApplicationIcon" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "${ORIVON_CLIENT_KEY}\Capabilities\URLAssociations" "http" "OrivonURL"
  WriteRegStr SHCTX "${ORIVON_CLIENT_KEY}\Capabilities\URLAssociations" "https" "OrivonURL"
  WriteRegStr SHCTX "Software\RegisteredApplications" "Orivon" "${ORIVON_CLIENT_KEY}\Capabilities"
  WriteRegStr SHCTX "${ORIVON_URL_CLASS}" "" "Orivon URL"
  WriteRegStr SHCTX "${ORIVON_URL_CLASS}" "URL Protocol" ""
  WriteRegStr SHCTX "${ORIVON_URL_CLASS}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "${ORIVON_URL_CLASS}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
!macroend

!macro customUnInstall
  DeleteRegKey SHCTX "${ORIVON_CLIENT_KEY}"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Orivon"
  DeleteRegKey SHCTX "${ORIVON_URL_CLASS}"
!macroend
