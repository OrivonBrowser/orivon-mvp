// Runs one scenario on this module and on Node's own node:sqlite, and expects the same outcome.

import { DatabaseSync as NodeDatabaseSync } from 'node:sqlite'
import { expect, it } from 'vitest'
import { DatabaseSync } from '../../database.js'

export type Database = DatabaseSync | NodeDatabaseSync

export function outcome (run: () => unknown): unknown {
  try {
    const value = run()
    return { value: JSON.parse(JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? `${item.toString()}n` : item instanceof Uint8Array ? [...item] : item)) as unknown }
  } catch (error) {
    const { name, message, code, errcode, errstr } = error as Record<string, unknown>
    return { error: { name, message, code, errcode, errstr } }
  }
}

/** Runs `scenario` on a fresh in-memory database of each implementation and expects the same outcome. */
export function same (label: string, scenario: (db: Database) => unknown, options?: object): void {
  it(label, () => {
    const mine = outcome(() => scenario(options === undefined ? new DatabaseSync(':memory:') : new DatabaseSync(':memory:', options)))
    const theirs = outcome(() => scenario(options === undefined ? new NodeDatabaseSync(':memory:') : new NodeDatabaseSync(':memory:', options)))
    expect(mine).toEqual(theirs)
  })
}
