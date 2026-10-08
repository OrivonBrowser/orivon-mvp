import { describe, expect, it } from 'vitest'
import { forgetChoicesWhenGrantEnds } from '../grant-watch.js'
import { SchemeChoices } from '../scheme-choices.js'

const APP = 'https://torrent.example'

function setup (state: { live?: boolean, registered?: boolean, persisted?: 'grants' | 'record-only' | 'none' } = {}) {
  const choices = new SchemeChoices(null)
  choices.set('magnet', APP)
  choices.set('bitcoin', APP)
  choices.set('mailto', 'https://mail.example')
  const status = { live: state.live ?? true, registered: state.registered ?? true, persisted: state.persisted ?? 'grants' }
  let fire: (origin: string) => void = () => {}
  forgetChoicesWhenGrantEnds({
    onGrantsChanged: (listener) => { fire = listener; return () => {} },
    app: {
      hasGrantsSync: () => status.live,
      isRegisteredSync: () => status.registered,
      persistedAppsSync: () => status.persisted === 'none' ? [] : [{ origin: APP, appName: 'Torrents', grants: status.persisted === 'grants' ? { net: { patterns: [], grantedAt: 0 } } : {}, pickedPaths: {} }]
    }
  }, choices)
  return { choices, status, fire: (origin: string) => { fire(origin) } }
}

describe('forgetChoicesWhenGrantEnds', () => {
  it('keeps the default while the app holds a grant', () => {
    const { choices, fire } = setup()
    fire(APP)
    expect(choices.schemesOf(APP).sort()).toEqual(['bitcoin', 'magnet'])
  })

  it('forgets every scheme the app was default for once it holds no grant, live or on disk, and no other app\'s', () => {
    const { choices, status, fire } = setup()
    status.live = false
    status.persisted = 'record-only'
    fire(APP)
    expect(choices.schemesOf(APP)).toEqual([])
    expect(choices.get('mailto')).toBe('https://mail.example')
  })

  it('keeps the default of an app not opened this session while its record still holds grants', () => {
    const { choices, status, fire } = setup()
    status.live = false
    fire(APP)
    expect(choices.get('magnet')).toBe(APP)
  })

  it('ignores an origin the browser knows nothing of', () => {
    const { choices, status, fire } = setup()
    status.live = false
    status.registered = false
    status.persisted = 'none'
    fire(APP)
    expect(choices.get('magnet')).toBe(APP)
  })
})
