import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabOpenerHost } from '../tab-open.js'
import type { TabFactory } from '../tab-factory.js'

const known = vi.hoisted(() => ({ fuse: undefined as 'off' | 'on' | 'unknown' | undefined }))
vi.mock('../../local-files/file-fuse.js', () => ({ knownFileProtocolFuse: () => known.fuse }))

const { TabOpener } = await import('../tab-open.js')

const FILE = 'file:///home/u/notes/app.html'

function setup (capacity = false): { opener: InstanceType<typeof TabOpener>, add: ReturnType<typeof vi.fn>, refused: ReturnType<typeof vi.fn>, localFile: ReturnType<typeof vi.fn> } {
  const add = vi.fn()
  const refused = vi.fn()
  const contents = { loadURL: vi.fn(() => Promise.resolve()) }
  const host: TabOpenerHost = {
    add, activate: vi.fn(), changed: vi.fn(), atCapacity: () => capacity, activeId: () => 'front', records: () => [], localFilesRefused: refused
  }
  const localFile = vi.fn(() => ({ id: 't1', target: FILE, record: { view: { webContents: contents } } }))
  return { opener: new TabOpener(host, { localFile } as unknown as TabFactory), add, refused, localFile }
}

beforeEach(() => { known.fuse = 'off' })

describe('TabOpener.openLocalFile and the binary\'s file-protocol fuse', () => {
  it('opens a tab while the fuse is off', () => {
    const { opener, add, refused } = setup()
    expect(opener.openLocalFile(FILE)).toBe('t1')
    expect(add).toHaveBeenCalledOnce()
    expect(refused).not.toHaveBeenCalled()
  })

  it.each(['on', 'unknown', undefined] as const)('opens no tab and says so while the fuse reads %s', (fuse) => {
    known.fuse = fuse
    const { opener, add, refused, localFile } = setup()

    expect(opener.openLocalFile(FILE)).toBeUndefined()
    expect(add).not.toHaveBeenCalled()
    expect(localFile).not.toHaveBeenCalled()
    expect(refused).toHaveBeenCalledOnce()
  })

  it('opens nothing at the tab limit, and says nothing about the fuse then', () => {
    const { opener, refused } = setup(true)
    expect(opener.openLocalFile(FILE)).toBeUndefined()
    expect(refused).not.toHaveBeenCalled()
  })
})
