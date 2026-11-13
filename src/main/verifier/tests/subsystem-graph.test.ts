import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// test:changed reads src/main/verifier/tests/

const TESTS = import.meta.dirname
const IMPORTS_IN_A_TEST = /await import\('[^']*verifier-subsystem\.js'\)/
const LOADS_FIRST = /^await loadSubsystemGraphOnce\(\)$/m

describe('the test files here that start the verifier subsystem from fresh module state', () => {
  it('each import its module graph once at the top, so no test pays that first import against its own timeout', () => {
    const files = readdirSync(TESTS).filter((name) => name.endsWith('.test.ts') && name !== 'subsystem-graph.test.ts')
    const late = files.filter((name) => {
      const text = readFileSync(join(TESTS, name), 'utf8')
      return IMPORTS_IN_A_TEST.test(text) && !LOADS_FIRST.test(text)
    })
    expect(late).toEqual([])
  })
})
