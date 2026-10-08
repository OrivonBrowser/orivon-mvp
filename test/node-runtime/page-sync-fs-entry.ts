// Bundled against the shim by ./e2e-page-sync-fs.test.ts into the fixture app's page script: Node's
// synchronous path-based fs calls on the page, then what the async calls see of them.

import * as fs from 'fs'

export interface PageSyncFsResults {
  readonly twinMembers?: string[]
  readonly twinReachesPage?: boolean
  readonly ops?: Record<string, unknown>
  readonly asyncSees?: Record<string, unknown>
  readonly quota?: { code?: string | undefined, orivonCode?: string | undefined, landed?: boolean }
  readonly openSync?: { name?: string | undefined, code?: string | undefined }
  readonly error?: string
}

type Orivon = { fs: { readFile: (path: string) => Promise<Uint8Array>, readdir: (path: string) => Promise<string[]>, stat: (path: string) => Promise<unknown> } }

async function run (): Promise<PageSyncFsResults> {
  const orivon = (window as unknown as { orivon: Orivon }).orivon
  const twin = (orivon as unknown as Record<symbol, { fs?: Record<string, unknown> } | undefined>)[Symbol.for('orivon.synchronous')]
  const ops: Record<string, unknown> = {}

  fs.mkdirSync('work/a/b', { recursive: true })
  fs.writeFileSync('work/a/b/note.txt', 'hello')
  fs.copyFileSync('work/a/b/note.txt', 'work/a/copy.txt')
  ops['stat'] = fs.statSync('work/a/b/note.txt').size
  ops['readdir'] = fs.readdirSync('work/a').sort()
  fs.renameSync('work/a/copy.txt', 'work/a/moved.txt')
  ops['read'] = fs.readFileSync('work/a/moved.txt', 'utf8')
  ops['exists'] = [fs.existsSync('work/a/moved.txt'), fs.existsSync('work/a/copy.txt')]
  try { fs.mkdirSync('work/a') } catch (error) { ops['mkdirExisting'] = (error as { code?: string }).code }
  try { fs.statSync('work/missing') } catch (error) { ops['statMissing'] = (error as { code?: string }).code }

  const asyncSees = {
    note: new TextDecoder().decode(await orivon.fs.readFile('work/a/b/note.txt')),
    moved: new TextDecoder().decode(await orivon.fs.readFile('work/a/moved.txt')),
    dir: (await orivon.fs.readdir('work/a')).sort(),
    promisesRead: await fs.promises.readFile('work/a/b/note.txt', 'utf8')
  }

  fs.rmSync('work', { recursive: true })
  ops['removed'] = await orivon.fs.stat('work').then(() => false, () => true)

  // The quota is 65536 bytes: the sync write is refused on the same ledger as the async one.
  const quota: { code?: string | undefined, orivonCode?: string | undefined, landed?: boolean } = {}
  try {
    fs.writeFileSync('big.bin', new Uint8Array(70_000))
  } catch (error) {
    quota.code = (error as { code?: string }).code
    quota.orivonCode = (error as { orivonCode?: string }).orivonCode
  }
  quota.landed = await orivon.fs.stat('big.bin').then(() => true, () => false)

  const openSync: { name?: string | undefined, code?: string | undefined } = {}
  try { fs.openSync('x.txt', 'w') } catch (error) { openSync.name = (error as Error).name; openSync.code = (error as { code?: string }).code }

  return { twinMembers: Object.keys(twin?.fs ?? {}).sort(), twinReachesPage: twin !== undefined, ops, asyncSees, quota, openSync }
}

;(globalThis as unknown as { pageSyncFsE2e: { run: () => Promise<PageSyncFsResults> } }).pageSyncFsE2e = {
  run: async () => { try { return await run() } catch (error) { return { error: String((error as Error)?.stack ?? error) } } }
}
