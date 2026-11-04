// What the Settings page may ask about graphics: whether to offer the WebGPU-on-X11 choice, and the last time Orivon
// turned it off. Answers from main's own state; the page sends nothing that decides it.
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { Revert } from './x11-vulkan.js'

export interface X11Offer {
  readonly offered: boolean
  readonly revert: Revert | null
}

export function graphicsDomain (offer: () => X11Offer): InternalDomain {
  return {
    pages: ['settings'],
    handle: (command) => {
      const type = typeof command === 'object' && command !== null ? (command as { type?: unknown }).type : undefined
      if (type !== 'x11Vulkan') return undefined
      return offer()
    }
  }
}
