// A `FileHandle` (src/contracts/handles.ts) over the web's own `FileSystemFileHandle`, which is what
// `showSaveFilePicker` returns. The picked-path table holds `FileHandle`s only, so a saved-to file is
// adapted here and then reached like any other pick. README.md's Design notes, "A saved-to file", has the
// commit rule.

import type { FileHandle, FileStat } from '../contracts/handles.js'
import { refuse } from './errors.js'

/** The slice of `FileSystemFileHandle` this adapter uses, so a test can stand in for it. */
export interface WebFileHandle {
  readonly name: string
  getFile: () => Promise<File>
  createWritable: (options?: { keepExistingData?: boolean }) => Promise<WebWritable>
}

export interface WebWritable {
  write: (chunk: { type: 'write', position: number, data: Uint8Array }) => Promise<void>
  truncate: (size: number) => Promise<void>
  close: () => Promise<void>
}

/** The Orivon error code a failed web call is closest to, which the Node shim then maps to an errno. */
function codeOf (error: unknown): string {
  switch ((error as { name?: string }).name) {
    case 'NotAllowedError': case 'SecurityError': return 'denied'
    case 'NotFoundError': return 'notFound'
    case 'QuotaExceededError': return 'limit'
    case 'InvalidStateError': return 'closed'
    default: return 'internal'
  }
}

function asOrivonError (error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  return Object.assign(new Error(message), { code: codeOf(error) })
}

let serial = 0

export function fileHandleFromWeb (web: WebFileHandle): FileHandle {
  let writable: WebWritable | undefined
  let queue: Promise<unknown> = Promise.resolve()
  let finish: () => void = () => {}
  const closed = new Promise<void>((resolve) => { finish = resolve })

  /** One call at a time, so two writes never race to open two writers on one file. */
  const inOrder = async <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run)
    queue = next.catch(() => {})
    try {
      return await next
    } catch (error) {
      throw asOrivonError(error)
    }
  }
  /** Commits what the writer holds: a web writer shows nothing on disk until it closes. */
  const commit = async (): Promise<void> => {
    const open = writable
    writable = undefined
    await open?.close()
  }
  const writer = async (): Promise<WebWritable> => {
    writable ??= await web.createWritable({ keepExistingData: true })
    return writable
  }
  const file = async (): Promise<File> => {
    await commit()
    return await web.getFile()
  }

  return {
    id: `saved-${String(++serial)}`,
    closed,
    close: async () => { await inOrder(commit); finish() },
    read: async ({ position, length }) => await inOrder(async () => new Uint8Array(await (await file()).slice(position, position + length).arrayBuffer())),
    write: async ({ position, data }) => await inOrder(async () => {
      await (await writer()).write({ type: 'write', position, data })
      return data.length
    }),
    readable: () => { throw refuse('FileHandle.readable', 'unimplemented', 'a saved-to file has no stream form here; read it by position') },
    writable: () => { throw refuse('FileHandle.writable', 'unimplemented', 'a saved-to file has no stream form here; write it by position') },
    stat: async (): Promise<FileStat> => await inOrder(async () => {
      const current = await file()
      return { size: current.size, isFile: true, isDirectory: false, mtimeMs: current.lastModified }
    }),
    truncate: async (length) => { await inOrder(async () => { await (await writer()).truncate(length) }) },
    sync: async () => { await inOrder(commit) }
  }
}
