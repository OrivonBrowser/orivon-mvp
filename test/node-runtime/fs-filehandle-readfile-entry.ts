// Bundled against the shim by ./e2e-fs-filehandle-readfile.test.ts into the fixture app's page script: a file handle
// from fs.promises.open asked to read the rest of the file, and to append, through the real broker and disk.

import * as fs from 'fs'

export interface FsFileHandleReadFileResults {
  readonly text?: string
  readonly isBuffer?: boolean
  readonly bufferLength?: number
  readonly objectForm?: string
  readonly partial?: { readonly head: string, readonly rest: string, readonly again: string, readonly readAfter: number }
  readonly large?: { readonly length: number, readonly intact: boolean }
  readonly empty?: string
  readonly badEncoding?: string
  readonly settings?: { readonly loaded: unknown, readonly fileAfter: string }
  readonly appended?: string
  readonly error?: string
}

const LARGE = 2_621_440

/** What a program does with its settings file: open it, read it whole, and fall back to defaults when anything throws. */
async function loadSettings (path: string): Promise<unknown> {
  try {
    const handle = await fs.promises.open(path, 'r')
    try { return JSON.parse(await handle.readFile('utf8') as string) } finally { await handle.close() }
  } catch {
    return { theme: 'defaults' }
  }
}

async function run (): Promise<FsFileHandleReadFileResults> {
  await fs.promises.writeFile('notes.txt', 'first line\nsecond line\n')
  const whole = await fs.promises.open('notes.txt', 'r')
  const text = await whole.readFile('utf8') as string
  await whole.close()

  const raw = await fs.promises.open('notes.txt', 'r')
  const bytes = await raw.readFile()
  await raw.close()

  const objectHandle = await fs.promises.open('notes.txt', 'r')
  const objectForm = await objectHandle.readFile({ encoding: 'utf8' }) as string
  await objectHandle.close()

  const partialHandle = await fs.promises.open('notes.txt', 'r')
  const headBuffer = new Uint8Array(5)
  await partialHandle.read(headBuffer, 0, 5)
  const rest = await partialHandle.readFile('utf8') as string
  const again = await partialHandle.readFile('utf8') as string
  const readAfter = (await partialHandle.read(new Uint8Array(4), 0, 4)).bytesRead
  await partialHandle.close()

  const pattern = new Uint8Array(LARGE).map((_, index) => index % 251)
  await fs.promises.writeFile('large.bin', pattern)
  const largeHandle = await fs.promises.open('large.bin', 'r')
  const large = await largeHandle.readFile() as Uint8Array
  await largeHandle.close()

  await fs.promises.writeFile('empty.txt', '')
  const emptyHandle = await fs.promises.open('empty.txt', 'r')
  const empty = await emptyHandle.readFile('utf8') as string
  await emptyHandle.close()

  const encodingHandle = await fs.promises.open('notes.txt', 'r')
  const badEncoding = await encodingHandle.readFile('not-an-encoding' as BufferEncoding).then(() => 'no error', (error: { code?: string }) => String(error.code))
  await encodingHandle.close()

  await fs.promises.writeFile('settings.json', JSON.stringify({ theme: 'dark', zoom: 125 }))
  const loaded = await loadSettings('settings.json')
  const fileAfter = await fs.promises.readFile('settings.json', 'utf8')

  const appendHandle = await fs.promises.open('appended.txt', 'w+')
  await appendHandle.appendFile('one,')
  await appendHandle.appendFile('two')
  await appendHandle.close()
  const appended = await fs.promises.readFile('appended.txt', 'utf8')

  return {
    text,
    isBuffer: bytes instanceof Uint8Array && typeof bytes !== 'string',
    bufferLength: (bytes as Uint8Array).length,
    objectForm,
    partial: { head: new TextDecoder().decode(headBuffer), rest, again, readAfter },
    large: { length: large.length, intact: large.every((value, index) => value === pattern[index]) },
    empty,
    badEncoding,
    settings: { loaded, fileAfter },
    appended
  }
}

;(globalThis as unknown as { fsFileHandleReadFileE2e: { run: () => Promise<FsFileHandleReadFileResults> } }).fsFileHandleReadFileE2e = {
  run: async () => { try { return await run() } catch (error) { return { error: String((error as Error)?.stack ?? error) } } }
}
