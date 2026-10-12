import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FloorFile } from '../floor-file.js'

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function floorFile (): { file: FloorFile, path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'floor-file-'))
  dirs.push(dir)
  const path = join(dir, 'floors.json')
  return { file: new FloorFile(dir, path, (key) => /^[a-z]+$/.test(key), 10, 'test floors'), path }
}

describe('FloorFile writes', () => {
  it('never overlap: concurrent flushes share one temporary file and all succeed', async () => {
    const { file, path } = floorFile()
    file.save('a', '1')
    await Promise.all([file.flush(), file.flush(), file.flush()])
    file.save('b', '2')
    await Promise.all([file.flush(), file.flush()])
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a: '1', b: '2' })
  })
})
