// src/shim-electron/ may not import src/shim/, so app.getPath('userData')
// keeps its own copy of the virtual root. This holds the two equal.

import { describe, expect, it } from 'vitest'
import { USER_DATA_PATH } from '../../shim-electron/app.js'
import { VIRTUAL_ROOT, VIRTUAL_TMPDIR } from '../virtual-root.js'

describe('the virtual root', () => {
  it('is the same path in electron\'s app.getPath(\'userData\')', () => {
    expect(USER_DATA_PATH).toBe(VIRTUAL_ROOT)
  })

  it('is absolute, and its tmp folder sits inside it', () => {
    expect(VIRTUAL_ROOT.startsWith('/')).toBe(true)
    expect(VIRTUAL_TMPDIR.startsWith(`${VIRTUAL_ROOT}/`)).toBe(true)
  })
})
