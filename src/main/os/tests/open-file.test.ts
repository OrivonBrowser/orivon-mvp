import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleOpenFile } from '../open-file.js'

let dir: string | undefined
afterEach(() => { if (dir !== undefined) rmSync(dir, { recursive: true, force: true }); dir = undefined })

describe('handleOpenFile', () => {
  it('claims the event and queues an existing file as its file: URL', () => {
    dir = mkdtempSync(join(tmpdir(), 'orivon-open-file-'))
    const path = join(dir, 'a b.html')
    writeFileSync(path, '<p>x</p>')
    const event = { preventDefault: vi.fn() }
    const queue = vi.fn()
    handleOpenFile(event, path, queue)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(queue).toHaveBeenCalledExactlyOnceWith([pathToFileURL(path).href])
  })

  it('claims the event and queues nothing for a path that is not there or is not a path', () => {
    const event = { preventDefault: vi.fn() }
    const queue = vi.fn()
    handleOpenFile(event, '/definitely/not/there/a.html', queue)
    handleOpenFile(event, 'https://example.com/', queue)
    expect(event.preventDefault).toHaveBeenCalledTimes(2)
    expect(queue).not.toHaveBeenCalled()
  })
})
