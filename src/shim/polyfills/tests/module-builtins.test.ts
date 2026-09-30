import { describe, expect, it } from 'vitest'
import { builtinModules, isBuiltin } from '../module.js'

describe('module.builtinModules and isBuiltin', () => {
  it('list a node:-only module with its prefix, as Node does', () => {
    expect(builtinModules).toContain('node:sqlite')
    expect(builtinModules).not.toContain('sqlite')
    expect(builtinModules).toContain('fs')
  })

  it('a node:-only module is a builtin only as node:sqlite', () => {
    expect(isBuiltin('node:sqlite')).toBe(true)
    expect(isBuiltin('sqlite')).toBe(false)
    expect(isBuiltin('fs')).toBe(true)
    expect(isBuiltin('node:fs')).toBe(true)
  })
})
