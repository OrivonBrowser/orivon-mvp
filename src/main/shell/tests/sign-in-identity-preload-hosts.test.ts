import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SIGN_IN_HOSTS } from '../sign-in-identity.js'

describe('the preload copy of the sign-in hosts', () => {
  it('lists exactly the hosts the main process does', () => {
    const source = readFileSync(new URL('../../../preload/sign-in-identity.ts', import.meta.url), 'utf8')
    const literal = /const SIGN_IN_HOSTS: readonly string\[\] = \[([^\]]*)\]/.exec(source)?.[1]
    expect(literal).toBeDefined()
    const hosts = [...(literal ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1])
    expect(hosts).toEqual([...SIGN_IN_HOSTS])
  })
})
