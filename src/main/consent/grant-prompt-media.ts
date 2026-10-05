// The consent copy for an app's media kinds (ADR-0032, ADR-0055), split out of ./grant-prompt-render.ts
// (docs/development/code-guidelines.md Rule 2). Pure and I/O-free, like that file.

import type { CapabilityGrantSummary } from './grant-prompt-connect.js'

/**
 * Never a warning: none of the three is broader than what its row says. A screen share is chosen again in Orivon's
 * picker each time, so the row says that rather than "your screen", which would promise more than a grant gives.
 */
export function describeMediaGrant (kind: 'media.camera' | 'media.microphone' | 'media.screen'): CapabilityGrantSummary {
  switch (kind) {
    case 'media.camera':
      return { warning: false, message: 'Use your camera' }
    case 'media.microphone':
      return { warning: false, message: 'Use your microphone' }
    case 'media.screen':
      return { warning: false, message: 'Ask to share your screen, a window or a tab; you choose each time' }
  }
}
