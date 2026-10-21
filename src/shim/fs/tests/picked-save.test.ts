// A path the save dialog returned, used through fs: the web's writer commits on close, so the shim closes
// (flushes) at the end of every call that writes. The web file here is an in-memory fake of a
// FileSystemFileHandle; a real save picker cannot be clicked headless (test/app-behaviours/catalogue.md).

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Orivon } from '../../../contracts/capability-api.js'
import type { WebFileHandle } from '../../../shim-electron/web-file-handle.js'

afterEach(() => { vi.resetModules() })

function fakeWebFile (initial = '') {
  let committed = new TextEncoder().encode(initial)
  const handle: WebFileHandle = {
    name: 'export.json',
    getFile: async () => new File([committed.slice()], 'export.json'),
    createWritable: async () => {
      let pending = committed.slice()
      return {
        write: async ({ position, data }) => {
          const grown = new Uint8Array(Math.max(pending.length, position + data.length))
          grown.set(pending)
          grown.set(data, position)
          pending = grown
        },
        truncate: async (size) => { const next = new Uint8Array(size); next.set(pending.subarray(0, size)); pending = next },
        close: async () => { committed = pending }
      }
    }
  }
  return { handle, committed: () => new TextDecoder().decode(committed) }
}

async function saved (web: WebFileHandle) {
  const { createDialog } = await import('../../../shim-electron/dialog.js')
  const promises = await import('../promises.js')
  const fs = await import('../fs.js')
  const dialog = createDialog({ fs: {} } as unknown as Pick<Orivon, 'fs'>, { saveFilePicker: () => async () => web, warn: () => {} })
  const { filePath } = await dialog.showSaveDialog({ defaultPath: 'export.json' })
  return { filePath, promises, fs }
}

describe('a path from showSaveDialog', () => {
  it('writeFile replaces the file and has committed it when the call settles', async () => {
    const web = fakeWebFile('an earlier, longer export')
    const { filePath, promises } = await saved(web.handle)
    await promises.writeFile(filePath, '{"a":1}')
    expect(web.committed()).toBe('{"a":1}')
    expect(await promises.readFile(filePath, 'utf8')).toBe('{"a":1}')
  })

  it('creates the folder it sits in as a no-op, then writes: what an export routine does first', async () => {
    const web = fakeWebFile()
    const { filePath, promises } = await saved(web.handle)
    await promises.mkdir(filePath.slice(0, filePath.lastIndexOf('/')), { recursive: true })
    await promises.writeFile(filePath, 'data')
    expect(web.committed()).toBe('data')
  })

  it('a write stream commits when it finishes', async () => {
    const web = fakeWebFile()
    const { filePath, fs } = await saved(web.handle)
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createWriteStream(filePath)
      stream.on('close', resolve)
      stream.on('error', reject)
      stream.write('part one, ')
      stream.end('part two')
    })
    expect(web.committed()).toBe('part one, part two')
  })

  it('appendFile adds to what the file holds', async () => {
    const web = fakeWebFile('first')
    const { filePath, promises } = await saved(web.handle)
    await promises.appendFile(filePath, ' second')
    expect(web.committed()).toBe('first second')
  })
})
