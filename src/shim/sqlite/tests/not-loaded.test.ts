import { describe, expect, it } from 'vitest'
import { DatabaseSync, StatementSync, constants, backup } from '../index.js'
import * as namespace from '../index.js'

describe('before the engine has loaded', () => {
  it('a database refuses by name and says what to import', () => {
    expect(() => new DatabaseSync(':memory:')).toThrow(expect.objectContaining({
      name: 'OrivonShimError', reason: 'not-built', message: expect.stringMatching(/sqlite\/ready|loadSqliteEngine/) as string
    }))
  })
})

describe('the module\'s members', () => {
  it('the default export is the module and refuses an unbuilt member when called', async () => {
    const { default: sqlite } = await import('../index.js')
    expect(sqlite.DatabaseSync).toBe(DatabaseSync)
    expect(sqlite.StatementSync).toBe(StatementSync)
    expect(sqlite.constants).toBe(constants)
    expect(() => backup()).toThrow(expect.objectContaining({ name: 'OrivonShimError', reason: 'not-built' }))
    expect(() => (sqlite as unknown as { Session: () => void }).Session()).toThrow(expect.objectContaining({ name: 'OrivonShimError' }))
  })

  it('the namespace, which a bundled require() reads, names every member Node has', () => {
    for (const name of ['DatabaseSync', 'StatementSync', 'Session', 'backup', 'constants']) expect(name in namespace, name).toBe(true)
  })

  it('constants are Node\'s values', () => {
    expect(constants.SQLITE_CHANGESET_ABORT).toBe(2)
    expect(constants.SQLITE_RECURSIVE).toBe(33)
    expect(Object.keys(constants)).toHaveLength(45)
    expect(Object.isFrozen(constants)).toBe(true)
  })
})
