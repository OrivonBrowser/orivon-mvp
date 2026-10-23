// Bundled against the shim by ./e2e-fs-ancestors.test.ts into the fixture app's page script: Node's fs asked about
// the directories above the app's files root, by a folder-making walk and by every call that must stay refused.

import * as fs from 'fs'

export interface FsAncestorsResults {
  readonly stat?: Record<string, boolean>
  readonly exists?: Record<string, boolean>
  readonly mkdir?: Record<string, string>
  readonly readdir?: Record<string, unknown>
  readonly walk?: { readonly made: boolean, readonly landedInFiles: boolean, readonly attempts: string[] }
  readonly refused?: Record<string, string>
  readonly error?: string
}

type Orivon = { fs: { readdir: (path: string) => Promise<string[]> } }

async function code (run: () => unknown): Promise<string> {
  try { await run(); return 'no error' } catch (error) { return String((error as { code?: string }).code) }
}

/** What `mkdirp` does: from `/`, stat each ancestor of the target and make the ones that are not directories. */
async function walkTo (target: string): Promise<string[]> {
  const attempts: string[] = []
  const parts = target.split('/').filter((part) => part !== '')
  for (let index = 0; index <= parts.length; index += 1) {
    const directory = `/${parts.slice(0, index).join('/')}`
    const isDirectory = await fs.promises.stat(directory).then((stat) => stat.isDirectory(), () => false)
    attempts.push(`${directory}:${isDirectory ? 'dir' : 'make'}`)
    if (!isDirectory) await fs.promises.mkdir(directory)
  }
  return attempts
}

async function run (): Promise<FsAncestorsResults> {
  const orivon = (window as unknown as { orivon: Orivon }).orivon
  await fs.promises.writeFile('canary.txt', 'a real file in the root')

  const stat: Record<string, boolean> = {}
  const exists: Record<string, boolean> = {}
  for (const path of ['/', '/orivon']) {
    stat[`async ${path}`] = (await fs.promises.stat(path)).isDirectory()
    stat[`sync ${path}`] = fs.statSync(path).isDirectory()
    exists[path] = fs.existsSync(path)
  }
  exists['/orivon/other'] = fs.existsSync('/orivon/other')

  const mkdir: Record<string, string> = {}
  for (const path of ['/', '/orivon']) {
    mkdir[`recursive ${path}`] = await code(async () => await fs.promises.mkdir(path, { recursive: true }))
    mkdir[`plain ${path}`] = await code(async () => await fs.promises.mkdir(path))
    mkdir[`sync plain ${path}`] = await code(() => fs.mkdirSync(path))
  }

  const readdir: Record<string, unknown> = {
    '/': await fs.promises.readdir('/'),
    '/orivon': await fs.promises.readdir('/orivon'),
    'sync /': fs.readdirSync('/'),
    canary: await fs.promises.readFile('canary.txt', 'utf8')
  }

  const attempts = await walkTo('/orivon/app/walk/a/b')
  const walk = {
    made: fs.statSync('/orivon/app/walk/a/b').isDirectory(),
    landedInFiles: (await orivon.fs.readdir('walk/a')).includes('b'),
    attempts
  }

  const refused: Record<string, string> = {
    'writeFile /': await code(async () => await fs.promises.writeFile('/x.txt', 'x')),
    'writeFile /orivon': await code(async () => await fs.promises.writeFile('/orivon/x.txt', 'x')),
    'writeFile beside the root': await code(async () => await fs.promises.writeFile('/orivon/other/x.txt', 'x')),
    'mkdir beside the root': await code(async () => await fs.promises.mkdir('/orivon/other', { recursive: true })),
    'rm /orivon': await code(async () => await fs.promises.rm('/orivon', { recursive: true })),
    'rename /orivon': await code(async () => await fs.promises.rename('/orivon', '/orivon2')),
    'rename into /': await code(async () => await fs.promises.rename('canary.txt', '/canary.txt')),
    'open /': await code(async () => await fs.promises.open('/', 'r')),
    'readFile /orivon': await code(async () => await fs.promises.readFile('/orivon')),
    'stat beside the root': await code(async () => await fs.promises.stat('/orivon/other')),
    'sync rmSync /': await code(() => fs.rmSync('/', { recursive: true }))
  }

  return { stat, exists, mkdir, readdir, walk, refused }
}

;(globalThis as unknown as { fsAncestorsE2e: { run: () => Promise<FsAncestorsResults> } }).fsAncestorsE2e = {
  run: async () => { try { return await run() } catch (error) { return { error: String((error as Error)?.stack ?? error) } } }
}
