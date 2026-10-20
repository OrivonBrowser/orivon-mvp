; Registers Orivon with Windows as a web browser, so it is listed under "Default apps" and the person can
; choose it for http and https. Windows keeps that choice per user and does not let a program set it:
; the app opens Settings (src/main/os/default-browser-runner.ts) and the person picks.
;
; The names below are what a pinned shortcut and a default-app choice key on: renaming one costs the person
; their choice, so they are fixed. The `--` in the URL command ends the switches, so a link can
; never be read as one.

!define ORIVON_CLIENT_KEY "Software\Clients\StartMenuInternet\Orivon"
!define ORIVON_URL_CLASS "Software\Classes\OrivonURL"
!define ORIVON_DOC_CLASS "Software\Classes\OrivonHTML"

; Orivon opens .html, .htm, .xhtml, .svg and .pdf files. They are listed under Capabilities and under each
; extension's OpenWithProgids, which puts Orivon in "Open with" and in Settings > Default apps; the install never
; takes an extension over, so the person's choice stays theirs. Provisional until measured on Windows.
!macro orivonDocExtension EXT
  WriteRegStr SHCTX "${ORIVON_CLIENT_KEY}\Capabilities\FileAssociations" "${EXT}" "OrivonHTML"
  WriteRegStr SHCTX "Software\Classes\${EXT}\OpenWithProgids" "OrivonHTML" ""
!macroend

!macro orivonDocExtensionRemove EXT
  DeleteRegValue SHCTX "Software\Classes\${EXT}\OpenWithProgids" "OrivonHTML"
!macroend

; The name of the file this installer was started from, written as it is: a package tagged for an app is a copy of
; the same installer under another name, and the browser reads the tag from this file the first time it runs. Nothing
; is parsed here (src/main/flavour/flavours.ts does that, against an allowlist).
!define ORIVON_INSTALLER_NAME "installer-name.txt"

!macro customInstall
  FileOpen $0 "$INSTDIR\${ORIVON_INSTALLER_NAME}" w
  FileWrite $0 "$EXEFILE"
  FileClose $0
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
  WriteRegStr SHCTX "${ORIVON_DOC_CLASS}" "" "Orivon document"
  WriteRegStr SHCTX "${ORIVON_DOC_CLASS}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr SHCTX "${ORIVON_DOC_CLASS}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" -- "%1"'
  !insertmacro orivonDocExtension ".html"
  !insertmacro orivonDocExtension ".htm"
  !insertmacro orivonDocExtension ".xhtml"
  !insertmacro orivonDocExtension ".svg"
  !insertmacro orivonDocExtension ".pdf"
!macroend

!macro customUnInstall
  Delete "$INSTDIR\${ORIVON_INSTALLER_NAME}"
  !insertmacro orivonDocExtensionRemove ".html"
  !insertmacro orivonDocExtensionRemove ".htm"
  !insertmacro orivonDocExtensionRemove ".xhtml"
  !insertmacro orivonDocExtensionRemove ".svg"
  !insertmacro orivonDocExtensionRemove ".pdf"
  DeleteRegKey SHCTX "${ORIVON_DOC_CLASS}"
  DeleteRegKey SHCTX "${ORIVON_CLIENT_KEY}"
  DeleteRegValue SHCTX "Software\RegisteredApplications" "Orivon"
  DeleteRegKey SHCTX "${ORIVON_URL_CLASS}"
!macroend
