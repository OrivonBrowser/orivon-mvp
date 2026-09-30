// The start-up overlay wired to the real displays, for the registry in ../overlays/overlays.ts.
import { screen } from 'electron'
import { restoreOverlayFor } from './restore-overlay.js'

export const restoreOverlay = restoreOverlayFor({ displays: () => screen.getAllDisplays() })
