// Every overlay page, keyed by the overlay's name (src/main/overlays/overlays.ts).
// One line per page, in name order.
import type { OverlayPage } from './kit.js'

export const OVERLAY_PAGES: Readonly<Record<string, OverlayPage>> = {}
