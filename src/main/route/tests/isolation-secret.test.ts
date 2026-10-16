import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { profileIsolationSecret } from '../isolation-secret.js'

const dirs: string[] = []
const profile = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-isolation-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('the secret the proxy user names are made under', () => {
  it('is 32 bytes, the same at every start of a profile, and another for another profile', () => {
    const one = profile()
    const secret = profileIsolationSecret(one)
    expect(secret.length).toBe(32)
    expect(Buffer.from(profileIsolationSecret(one)).equals(Buffer.from(secret))).toBe(true)
    expect(Buffer.from(profileIsolationSecret(profile())).equals(Buffer.from(secret))).toBe(false)
  })

  it('lasts for the run only when the profile cannot keep it', () => {
    const dir = profile()
    writeFileSync(join(dir, 'verifier'), 'a file where the folder should be')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const first = profileIsolationSecret(dir)
    expect(first.length).toBe(32)
    expect(Buffer.from(profileIsolationSecret(dir)).equals(Buffer.from(first))).toBe(false)
  })
})
