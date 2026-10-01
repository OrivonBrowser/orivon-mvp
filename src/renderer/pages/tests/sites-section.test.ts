import { describe, expect, it } from 'vitest'
import { sitesSection } from '../settings/sections/sites.js'
import { copyFor } from '../settings/sites/sites-copy.js'
import type { DefaultRow } from '../settings/sites/sites-model.js'
import type { SettingsState } from '../settings/state.js'
import { searchRows } from '../settings/search.js'

const ASK = [{ value: 'ask', label: 'Ask' }, { value: 'block', label: 'Block' }] as const
const DEFAULTS: DefaultRow[] = [
  { kind: 'camera', label: 'Camera', group: 'permission', settingKey: 'sites.camera', options: ASK },
  { kind: 'idle', label: 'Idle detection', group: 'permission', settingKey: 'sites.idle', options: ASK },
  { kind: 'javascript', label: 'JavaScript', group: 'content', settingKey: 'sites.javascript', options: [{ value: 'allow', label: 'Allow' }, { value: 'block', label: 'Block' }] },
  { kind: 'teleport' as never, label: 'Teleport', group: 'device', settingKey: 'sites.devices', options: ASK }
]

const state = { part: () => ({ defaults: DEFAULTS, isPrivate: false }) } as unknown as SettingsState

describe('the Site settings section', () => {
  const section = sitesSection(state)

  it('has a row for each kind main lists, by group, and then the list of sites', () => {
    expect(section.rows.map((row) => [row.id, row.group])).toEqual([
      ['sites-camera', 'Permissions'], ['sites-idle', 'Permissions'], ['sites-teleport', 'Permissions'],
      ['sites-javascript', 'Content'],
      ['sites-list', 'Sites']
    ])
  })

  it('gives each default the setting main named and the words main chose for its choices', () => {
    const camera = section.rows.find((row) => row.id === 'sites-camera')
    expect(camera?.control).toEqual({ type: 'choice', key: 'sites.camera', options: ASK })
    const javascript = section.rows.find((row) => row.id === 'sites-javascript')
    expect(javascript?.control).toMatchObject({ options: [{ label: 'Allow' }, { label: 'Block' }] })
  })

  it('is found by what a person would type, for a kind it has no copy for too', () => {
    const sections = [section]
    const found = (query: string): string[] => searchRows(sections, query, () => true).map((hit) => hit.row.id)
    expect(found('webcam')).toContain('sites-camera')
    expect(found('away')).toContain('sites-idle')
    expect(found('device use')).toContain('sites-idle')
    expect(found('teleport')).toContain('sites-teleport')
    expect(found('exceptions')).toContain('sites-list')
  })

  it('writes a line from the label for a kind with no entry', () => {
    expect(copyFor(DEFAULTS[3] as DefaultRow)).toMatchObject({ help: 'What sites may do with teleport.', group: 'Permissions' })
  })
})
