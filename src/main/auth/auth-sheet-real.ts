// The sign-in sheet wired to the process's pending sign-ins, for the registry in ../overlays/overlays.ts.
import { authSheetOverlayFor } from './auth-sheet-overlay.js'
import { challenges, rememberWhenLoaded } from './auth-state.js'

export const authSheetOverlay = authSheetOverlayFor({ challenges, submitted: (window, vault, tabId) => { rememberWhenLoaded(window, tabId, vault) } })
