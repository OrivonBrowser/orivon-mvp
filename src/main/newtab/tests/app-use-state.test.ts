import { describe, expect, it } from 'vitest'
import { MAX_APPS_REMEMBERED, NOTE_AGAIN_MS, forgetSince, noteUse, parseUse, serializeUse, type AppUseState } from '../app-use-state.js'

const ICON = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

describe('noteUse', () => {
  it('remembers the origin and when it was used', () => {
    expect(noteUse({}, 'https://a.example', null, 1000)).toEqual({ 'https://a.example': { usedAt: 1000, icon: null } })
  })

  it('does nothing for the newest origin again within the minute, so a busy page does not rewrite the file', () => {
    const state = noteUse({}, 'https://a.example', null, 1000)
    expect(noteUse(state, 'https://a.example', null, 1000 + NOTE_AGAIN_MS - 1)).toBe(state)
    expect(noteUse(state, 'https://a.example', null, 1000 + NOTE_AGAIN_MS)['https://a.example']?.usedAt).toBe(1000 + NOTE_AGAIN_MS)
  })

  it('notes an older app again at once, since coming back to it changes the order', () => {
    let state = noteUse({}, 'https://a.example', null, 1000)
    state = noteUse(state, 'https://b.example', null, 2000)
    expect(noteUse(state, 'https://a.example', null, 3000)['https://a.example']?.usedAt).toBe(3000)
  })

  it('takes a new icon at once and keeps the old one when none comes with the use', () => {
    const first = noteUse({}, 'https://a.example', null, 1000)
    const withIcon = noteUse(first, 'https://a.example', ICON, 1001)
    expect(withIcon['https://a.example']?.icon).toMatch(/^data:image\//)
    expect(noteUse(withIcon, 'https://a.example', null, 1000 + NOTE_AGAIN_MS)['https://a.example']?.icon).toBe(withIcon['https://a.example']?.icon)
  })

  it('refuses an icon that is not an image', () => {
    expect(noteUse({}, 'https://a.example', 'data:text/html,<script>', 1)['https://a.example']?.icon).toBeNull()
    expect(noteUse({}, 'https://a.example', 'https://a.example/icon.png', 1)['https://a.example']?.icon).toBeNull()
  })

  it('keeps the newest origins when there are more than the cap', () => {
    let state: AppUseState = {}
    for (let i = 0; i < MAX_APPS_REMEMBERED + 5; i++) state = noteUse(state, `https://app${i}.example`, null, 1000 + i)
    expect(Object.keys(state)).toHaveLength(MAX_APPS_REMEMBERED)
    expect(state['https://app0.example']).toBeUndefined()
    expect(state[`https://app${MAX_APPS_REMEMBERED + 4}.example`]).toBeDefined()
  })

  it('ignores an origin that is empty or absurdly long', () => {
    expect(noteUse({}, '', null, 1)).toEqual({})
    expect(noteUse({}, `https://${'a'.repeat(3000)}.example`, null, 1)).toEqual({})
  })
})

describe('forgetSince', () => {
  it('forgets the uses from a time on, and every one for 0', () => {
    const state: AppUseState = { 'https://a.example': { usedAt: 100, icon: null }, 'https://b.example': { usedAt: 300, icon: null } }
    expect(Object.keys(forgetSince(state, 200))).toEqual(['https://a.example'])
    expect(forgetSince(state, 0)).toEqual({})
    expect(forgetSince(state, 1000)).toBe(state)
  })
})

describe('parseUse and serializeUse', () => {
  it('round-trips', () => {
    const state: AppUseState = { 'https://a.example': { usedAt: 5, icon: null } }
    expect(parseUse(JSON.parse(serializeUse(state)))).toEqual(state)
  })

  it('drops whatever this version did not write, since a person can edit the file', () => {
    expect(parseUse(null)).toEqual({})
    expect(parseUse({ version: 2, apps: { 'https://a.example': { usedAt: 1 } } })).toEqual({})
    expect(parseUse({ version: 1, apps: { 'https://a.example': { usedAt: 'soon' }, 'https://b.example': { usedAt: 7, icon: 'javascript:1' } } })).toEqual({ 'https://b.example': { usedAt: 7, icon: null } })
  })
})
