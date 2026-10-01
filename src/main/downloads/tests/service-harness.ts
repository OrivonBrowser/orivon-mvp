// A service with a fake machine under it, shared by the service's test files.
import { join } from 'node:path'
import { vi } from 'vitest'
import { DownloadService } from '../download-service.js'
import type { DownloadDeps } from '../download-service.js'
import type { DownloadStore } from '../download-store.js'
import type { DownloadEntry } from '../download-types.js'
import { fakeContents, FakeItem } from './fake-item.js'

export const DIR = join('/', 'dl')

export function harness (stored: DownloadEntry[] = [], over: Partial<DownloadDeps> = {}) {
  const files = new Set<string>()
  const written: DownloadEntry[][] = []
  const store: DownloadStore = { read: () => stored, write: (entries) => { written.push([...entries]) }, flush: async () => {} }
  let clock = 1000
  let counter = 0
  const deps: DownloadDeps = {
    folder: () => DIR,
    fallbackFolder: () => join('/', 'system'),
    askWhere: () => false,
    fileExists: (path) => files.has(path),
    ensureFolder: vi.fn(() => true),
    folderWritable: () => true,
    openPath: vi.fn(async () => ''),
    showInFolder: vi.fn(),
    trash: vi.fn(async (path: string) => { files.delete(path) }),
    rename: vi.fn((from: string, to: string) => { files.delete(from); files.add(to) }),
    removeFile: vi.fn((path: string) => { files.delete(path) }),
    fetchAgain: vi.fn(),
    now: () => { clock += 1; return clock },
    newId: () => { counter += 1; return `id${String(counter)}` },
    ...over
  }
  const service = new DownloadService(store, deps)
  const event = { preventDefault: vi.fn() }
  const start = (item: FakeItem, tab = 1): string => {
    const seen: string[] = []
    const off = service.onStart((info) => { seen.push(info.id) })
    service.track(item.asItem(), fakeContents(tab), event)
    off()
    return seen[0] ?? ''
  }
  return { service, deps, files, written, event, start }
}

export const item = (name = 'file.bin', mime?: string, total?: number): FakeItem => new FakeItem(name, ['https://a.example/' + name], mime, total)

