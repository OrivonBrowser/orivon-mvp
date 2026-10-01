import { describe, expect, it } from 'vitest'
import type { SiteKindRow } from '../../main/site-settings/site-settings-controller.js'
import type { SitePermissionsView } from '../../main/site-settings/site-permissions-view.js'
import { splitRows } from '../site-info/permissions-model.js'

const row = (kind: SiteKindRow['kind'], value: SiteKindRow['value'] = 'default'): SiteKindRow => ({ kind, label: kind, group: 'permission', value, defaultValue: 'ask', options: [] })
const view = (shown: SitePermissionsView['shown']): SitePermissionsView => ({ rows: [row('camera'), row('microphone', 'allow'), row('location'), row('notifications')], shown, isPrivate: false })

describe('the permissions the popover lists', () => {
  it('lists what main shows and keeps the rest behind "Add a permission", in the table\'s order', () => {
    const { listed, more } = splitRows(view(['microphone', 'camera']), new Set())
    expect(listed.map((r) => r.kind)).toEqual(['camera', 'microphone'])
    expect(more.map((r) => r.kind)).toEqual(['location', 'notifications'])
  })

  it('keeps listing a kind the person set in this visit even when it is back at its default', () => {
    const { listed, more } = splitRows(view([]), new Set(['location'] as const))
    expect(listed.map((r) => r.kind)).toEqual(['location'])
    expect(more.map((r) => r.kind)).toEqual(['camera', 'microphone', 'notifications'])
  })

  it('lists nothing when nothing was asked, and everything is waiting', () => {
    const { listed, more } = splitRows(view([]), new Set())
    expect(listed).toEqual([])
    expect(more).toHaveLength(4)
  })
})
