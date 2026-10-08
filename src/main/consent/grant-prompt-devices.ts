// The consent copy for an app's hardware kinds (ADR-0068), split out of ./grant-prompt-render.ts
// (docs/development/code-guidelines.md Rule 2). Pure and I/O-free, like that file.

import type { Pattern } from '../../contracts/index.js'
import type { CapabilityGrantSummary } from './grant-prompt-connect.js'

const MAX_VENDORS_NAMED = 4
const VENDOR_FIELD = /(?:^|,)vendor=([0-9a-f]{4})(?:,|$)/

/**
 * Never a warning: a grant only bounds which devices can be offered, and the person is asked again for each one. The
 * row names the vendors, the one thing in a filter a person can look up, and says the second question exists.
 */
export function describeDevicesGrant (kind: 'devices.hid', patterns: readonly Pattern[]): CapabilityGrantSummary {
  switch (kind) {
    case 'devices.hid': {
      const vendors: string[] = []
      for (const pattern of patterns) {
        const hex = VENDOR_FIELD.exec(pattern)?.[1]
        const shown = hex === undefined ? undefined : `0x${hex.toUpperCase()}`
        if (shown !== undefined && !vendors.includes(shown)) vendors.push(shown)
      }
      const named = vendors.slice(0, MAX_VENDORS_NAMED).join(', ')
      const more = vendors.length > MAX_VENDORS_NAMED ? ` and ${vendors.length - MAX_VENDORS_NAMED} more` : ''
      return {
        warning: false,
        message: vendors.length === 0
          ? 'Use USB devices'
          : `Use USB devices from ${vendors.length === 1 ? 'vendor' : 'vendors'} ${named}${more}`,
        explanation: 'You will be asked again before each device connects. A device from another vendor is never offered to this app.'
      }
    }
  }
}
