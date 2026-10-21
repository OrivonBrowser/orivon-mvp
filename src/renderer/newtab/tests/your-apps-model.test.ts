import { describe, expect, it } from 'vitest'
import { readYourApps, yourAppsView, YOUR_APPS_EMPTY } from '../your-apps-model.js'

describe('yourAppsView', () => {
  it('says what the row is for when no app holds a grant', () => {
    expect(yourAppsView({ apps: [], isPrivate: false })).toEqual({ shown: true, tiles: [], empty: 'Apps you allow appear here' })
    expect(YOUR_APPS_EMPTY).toBe('Apps you allow appear here')
  })

  it('leaves the row out of a private window that holds no grants, and shows it once one does', () => {
    expect(yourAppsView({ apps: [], isPrivate: true }).shown).toBe(false)
    const tile = { origin: 'https://a.example', name: 'A', icon: null }
    expect(yourAppsView({ apps: [tile], isPrivate: true })).toEqual({ shown: true, tiles: [tile], empty: null })
  })
})

describe('readYourApps', () => {
  it('reads the tiles main sent, in order', () => {
    const answer = { apps: [{ origin: 'https://b.example', name: 'B', icon: null }, { origin: 'https://a.example', name: 'A', icon: 'data:image/png;base64,AAAA' }], isPrivate: false }
    expect(readYourApps(answer)).toEqual(answer)
  })

  it('draws nothing wrong for an answer that is not the shape', () => {
    expect(readYourApps(undefined)).toEqual({ apps: [], isPrivate: false })
    expect(readYourApps({ apps: 'x', isPrivate: 1 })).toEqual({ apps: [], isPrivate: false })
    expect(readYourApps({ apps: [null, { origin: 7 }, { origin: '', name: 'x' }, { origin: 'https://a.example', name: '', icon: 'https://evil.example/i.png' }] }))
      .toEqual({ apps: [{ origin: 'https://a.example', name: 'https://a.example', icon: null }], isPrivate: false })
  })
})
