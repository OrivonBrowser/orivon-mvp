import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { copyPrivatePicture, hasPrivatePicture } from '../private-picture.js'

let root: string
let from: string
let into: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orivon-private-picture-'))
  from = join(root, 'profile')
  into = join(root, 'private')
  await mkdir(from)
  await mkdir(into)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('copyPrivatePicture', () => {
  it('gives the private session the picture of the profile that opened it, and leaves the original', async () => {
    await writeFile(join(from, 'new-tab-background'), 'the picture')
    expect(hasPrivatePicture(from)).toBe(true)
    expect(await copyPrivatePicture(from, into)).toBe(true)
    expect(await readFile(join(into, 'new-tab-background'), 'utf8')).toBe('the picture')
    expect(existsSync(join(from, 'new-tab-background'))).toBe(true)
  })

  it('does nothing for a profile with no picture', async () => {
    expect(hasPrivatePicture(from)).toBe(false)
    expect(await copyPrivatePicture(from, into)).toBe(false)
    expect(existsSync(join(into, 'new-tab-background'))).toBe(false)
  })

  it('never rejects: a folder that is gone is a session without the picture', async () => {
    await writeFile(join(from, 'new-tab-background'), 'x')
    expect(await copyPrivatePicture(from, join(root, 'missing'))).toBe(false)
  })
})
