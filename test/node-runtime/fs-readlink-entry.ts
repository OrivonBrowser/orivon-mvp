// Bundled against the shim by ./e2e-fs-readlink.test.ts into the fixture app's page script: Node's readlink asked
// about the app's files in its callback, promise and synchronous forms, and the write helper that needs the
// answer (resolve the path, ask whether it is a link, save through a temporary file and a rename).

import * as fs from 'fs'

export interface ReadlinkAnswer {
  readonly code?: string | undefined
  readonly errno?: number | undefined
  readonly syscall?: string | undefined
  readonly path?: string | undefined
  readonly message?: string | undefined
  readonly returned?: string | undefined
}

export interface FsReadlinkResults {
  /** Each case, asked three ways: `answers[case]` holds the `callback`, `promise` and `sync` answers. */
  readonly answers?: Record<string, { callback: ReadlinkAnswer, promise: ReadlinkAnswer, sync: ReadlinkAnswer }>
  /** `fs.promises.readlink` handed back a promise and did not throw while being called. */
  readonly promiseReturnedNotThrown?: boolean
  /** The write helper's two probes for a file that is not there yet, then what it wrote. */
  readonly writer?: { readonly realpathCode: string, readonly readlinkResult: string, readonly written: string }
  readonly error?: string
}

function answerOf (error: unknown): ReadlinkAnswer {
  const failure = error as { code?: string, errno?: number, syscall?: string, path?: string, message?: string }
  return { code: failure.code, errno: failure.errno, syscall: failure.syscall, path: failure.path, message: failure.message }
}

async function ask (path: string): Promise<{ callback: ReadlinkAnswer, promise: ReadlinkAnswer, sync: ReadlinkAnswer }> {
  const callback = await new Promise<ReadlinkAnswer>((resolve) => {
    fs.readlink(path, (error, target) => resolve(error === null ? { returned: String(target) } : answerOf(error)))
  })
  const promise = await fs.promises.readlink(path).then((target) => ({ returned: String(target) }), answerOf)
  let sync: ReadlinkAnswer
  try { sync = { returned: String(fs.readlinkSync(path)) } } catch (error) { sync = answerOf(error) }
  return { callback, promise, sync }
}

/** What write-file-atomic-style helpers do: follow a link to its target if the path is one, and replace the file by a rename. */
async function saveResolved (path: string, data: string): Promise<{ realpathCode: string, readlinkResult: string }> {
  let realpathCode = 'no error'
  await fs.promises.realpath(path).catch((error: { code?: string }) => { realpathCode = String(error.code) })
  const link = await fs.promises.readlink(path).catch(() => null)
  const target = link === null ? path : String(link)
  await fs.promises.writeFile(`${target}.tmp`, data)
  await fs.promises.rename(`${target}.tmp`, target)
  return { realpathCode, readlinkResult: link === null ? 'null' : 'a target' }
}

async function run (): Promise<FsReadlinkResults> {
  await fs.promises.writeFile('present.txt', 'a file')
  await fs.promises.mkdir('folder', { recursive: true })

  const answers: NonNullable<FsReadlinkResults['answers']> = {}
  for (const [name, path] of Object.entries({
    missing: 'no-such-file.txt',
    missingInFolder: 'folder/no-such-file.txt',
    file: 'present.txt',
    folder: 'folder',
    root: '/orivon/app',
    absoluteFile: '/orivon/app/present.txt',
    absoluteMissing: '/orivon/app/no-such-file.txt',
    aboveRoot: '/orivon',
    top: '/',
    besideRoot: '/orivon/other',
    outside: '/etc/hostname'
  })) {
    answers[name] = await ask(path)
  }

  let pending: Promise<unknown> | undefined
  let threw = false
  try { pending = fs.promises.readlink('no-such-file.txt') } catch { threw = true }
  const promiseReturnedNotThrown = !threw && pending instanceof Promise
  await pending?.catch(() => undefined)

  const probes = await saveResolved('saved-once.txt', 'the new file')
  const written = await fs.promises.readFile('saved-once.txt', 'utf8')

  return { answers, promiseReturnedNotThrown, writer: { ...probes, written } }
}

;(globalThis as unknown as { fsReadlinkE2e: { run: () => Promise<FsReadlinkResults> } }).fsReadlinkE2e = {
  run: async () => { try { return await run() } catch (error) { return { error: String((error as Error)?.stack ?? error) } } }
}
