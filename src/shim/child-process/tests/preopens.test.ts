import { describe, expect, it } from 'vitest'
import { preopensFor } from '../spawn.js'
import { VIRTUAL_ROOT } from '../../virtual-root.js'

describe('the directories a spawned program is given', () => {
  it('holds the app\'s files as / and as the path the app\'s own code uses', () => {
    expect(preopensFor(undefined)).toEqual({ '/': VIRTUAL_ROOT, [VIRTUAL_ROOT]: VIRTUAL_ROOT, '.': VIRTUAL_ROOT })
  })

  it('holds the working directory as . and refuses one outside the app\'s files', () => {
    expect(preopensFor(`${VIRTUAL_ROOT}/work`)['.']).toBe(`${VIRTUAL_ROOT}/work`)
    expect(() => preopensFor('/etc')).toThrow()
  })
})
