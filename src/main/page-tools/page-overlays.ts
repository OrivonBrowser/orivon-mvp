// The page tools' overlays wired to the real machine, for the registry in ../overlays/overlays.ts.
import { realDeps } from './real-deps.js'
import { screenshotOverlayFor } from './screenshot-overlay.js'

export const screenshotOverlay = screenshotOverlayFor(realDeps)
export { toastOverlay } from './toast-overlay.js'
