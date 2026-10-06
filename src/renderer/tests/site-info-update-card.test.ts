import { describe, expect, it } from 'vitest'
import type { SiteUpdate } from '../../main/permissions/site-info.js'
import { updateButtonLabel, updateHeading } from '../site-info/update-card.js'

// The words the card shows; the DOM is covered by the end-to-end specs that open the popover.

const UPDATE: SiteUpdate = { toCid: 'b', toVersion: '1.0.1', fromVersion: '1.0.0', verified: true, level: 3, reasons: [] }

describe('the update card', () => {
  it('names both versions, or the new one alone when the pin is unreadable', () => {
    expect(updateHeading(UPDATE)).toBe('Version 1.0.1 is available (you have 1.0.0)')
    expect(updateHeading({ ...UPDATE, fromVersion: undefined })).toBe('Version 1.0.1 is available')
  })

  it('offers Update for a verified version and only Trust & Force update otherwise', () => {
    expect(updateButtonLabel(UPDATE)).toBe('Update')
    expect(updateButtonLabel({ ...UPDATE, verified: false })).toBe('Trust & Force update')
  })
})
