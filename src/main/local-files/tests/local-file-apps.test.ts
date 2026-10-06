import { writeFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LocalFileApps, MAX_RECORDED_FILES, installLocalFileApps, isRecordedLocalFile, isRecordedLocalPath, isUnrecordedLocalFile } from '../local-file-apps.js'

const FILE = 'file:///home/u/notes/app.html'
const SIBLING = 'file:///home/u/notes/other.html'

let dir: string
let path: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'orivon-local-apps-'))
  path = join(dir, 'local-file-apps.json')
})
afterEach(async () => {
  installLocalFileApps(undefined)
  await rm(dir, { recursive: true, force: true })
})

describe('LocalFileApps -- the files a person let use Orivon permissions', () => {
  it('starts empty when there is no file', () => {
    const apps = new LocalFileApps(path)
    expect(apps.has(FILE)).toBe(false)
    expect(apps.list()).toEqual([])
  })

  it('records a key, and a second store reading the same file sees it', async () => {
    const apps = new LocalFileApps(path)
    expect(apps.add(FILE)).toBe(true)

    expect(apps.has(FILE)).toBe(true)
    expect(apps.has(SIBLING)).toBe(false)
    expect(new LocalFileApps(path).has(FILE)).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 1, files: [FILE] })
  })

  it('records a key once and forgets it on remove, on disk too', () => {
    const apps = new LocalFileApps(path)
    apps.add(FILE)
    apps.add(FILE)
    expect(apps.list()).toEqual([FILE])

    expect(apps.remove(FILE)).toBe(true)
    expect(apps.has(FILE)).toBe(false)
    expect(new LocalFileApps(path).list()).toEqual([])
    expect(apps.remove(FILE)).toBe(false)
  })

  it('refuses a string that is not exactly a local-file key', () => {
    const apps = new LocalFileApps(path)
    for (const notAKey of ['https://x.example', 'file://host/a.html', `${FILE}?q=1`, `${FILE}#f`, 'file:////share/a.html', '']) {
      expect(apps.add(notAKey)).toBe(false)
    }
    expect(apps.list()).toEqual([])
  })

  it('reads a corrupt or foreign file as empty, and drops entries that are not keys', async () => {
    await writeFile(path, '{not json')
    expect(new LocalFileApps(path).list()).toEqual([])

    await writeFile(path, JSON.stringify({ version: 1, files: [FILE, 'https://x.example', 7, `${SIBLING}?q`] }))
    expect(new LocalFileApps(path).list()).toEqual([FILE])

    await writeFile(path, JSON.stringify({ version: 2, files: [FILE] }))
    expect(new LocalFileApps(path).list()).toEqual([])
  })

  it('is capped: a file past the limit is refused, and one already recorded still answers', () => {
    const files = Array.from({ length: MAX_RECORDED_FILES + 5 }, (_, n) => `file:///d/${String(n)}.html`)
    writeFileSync(path, JSON.stringify({ version: 1, files }))
    const apps = new LocalFileApps(path)
    expect(apps.list()).toHaveLength(MAX_RECORDED_FILES)

    expect(apps.add(FILE)).toBe(false)
    expect(apps.has('file:///d/0.html')).toBe(true)
    expect(apps.add('file:///d/0.html')).toBe(true)
  })

  it('answers false and records nothing when the file cannot be written', () => {
    expect(new LocalFileApps(join(dir, 'missing', 'deeper', 'f.json')).add(FILE)).toBe(true) // the folder is made
    writeFileSync(path, 'x')
    const blocked = new LocalFileApps(join(path, 'under-a-file.json'))
    expect(blocked.add(FILE)).toBe(false)
    expect(blocked.has(FILE)).toBe(false)
  })
})

describe('the installed record, as the rest of the shell asks it', () => {
  it('answers false for everything until a record is installed', () => {
    expect(isRecordedLocalFile(FILE)).toBe(false)
    expect(isRecordedLocalPath('/home/u/notes/app.html')).toBe(false)
  })

  it('answers from the installed record, by key and by file-system path for the planted-file check', () => {
    const apps = new LocalFileApps(path)
    apps.add(FILE)
    installLocalFileApps(apps)

    expect(isRecordedLocalFile(FILE)).toBe(true)
    expect(isRecordedLocalFile(SIBLING)).toBe(false)
    expect(isRecordedLocalPath('/home/u/notes/app.html')).toBe(true)
    expect(isRecordedLocalPath('/home/u/notes/other.html')).toBe(false)
  })
})

describe('isUnrecordedLocalFile', () => {
  it('is true for a file key nobody recorded, false for a recorded one and for a website', () => {
    const apps = new LocalFileApps(path)
    installLocalFileApps(apps)
    apps.add(FILE)
    expect(isUnrecordedLocalFile(SIBLING)).toBe(true)
    expect(isUnrecordedLocalFile(FILE)).toBe(false)
    expect(isUnrecordedLocalFile('https://app.example')).toBe(false)
  })

  it('is true for every file key before a record is installed', () => {
    expect(isUnrecordedLocalFile(FILE)).toBe(true)
  })
})
