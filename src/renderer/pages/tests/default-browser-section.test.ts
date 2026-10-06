import { describe, expect, it } from 'vitest'
import { groupLabelFor, NAV_ICON } from '../settings/nav.js'
import { defaultBrowserSection } from '../settings/sections/default-browser.js'
import type { SettingsState } from '../settings/state.js'

const stateFor = (isPrivate: boolean): SettingsState => ({ profiles: { isPrivate } }) as unknown as SettingsState

describe('the Default browser section', () => {
  it('holds the one row, after Search in the Browsing group, with an icon of its own', () => {
    const section = defaultBrowserSection(stateFor(false))
    expect(section).toMatchObject({ id: 'default-browser', title: 'Default browser' })
    expect(section.rows.map((row) => row.id)).toEqual(['default-browser'])
    expect(NAV_ICON['default-browser']).toBeTypeOf('function')
    expect(groupLabelFor(section, { id: 'search', title: 'Search', rows: [] })).toBeNull()
  })

  it('has no rows in a private window, so it is not listed there', () => {
    expect(defaultBrowserSection(stateFor(true)).rows).toEqual([])
  })
})
