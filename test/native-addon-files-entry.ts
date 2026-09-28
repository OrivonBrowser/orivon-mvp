// Bundled against the shim by ./e2e-native-addon.test.ts into the cross-origin
// isolated fixture's page script: an addon's file calls, refused on the page's
// main thread, reach the app's files from a forked child.

import { fork } from 'child_process'
import { createRequire } from 'module'

export interface NativeAddonFileResults {
  readonly isolated?: boolean
  readonly pageOpenErrno?: number
  readonly forked?: unknown
  readonly written?: string
  readonly error?: string
}

interface FilesFs { writeFile (path: string, data: Uint8Array): Promise<void>, readFile (path: string): Promise<Uint8Array> }

async function run (): Promise<NativeAddonFileResults> {
  const { fs } = (globalThis as unknown as { orivon: { fs: FilesFs } }).orivon
  await fs.writeFile('data.txt', new TextEncoder().encode('written by the page'))
  const require = createRequire('/index.js')
  const onPage = require('./native/files.node') as { openErrno: number }
  const child = fork('/files-child.js', [], { silent: true })
  const forked = await new Promise((resolve) => { child.once('message', resolve); child.once('exit', (code: number | null) => resolve({ exitedWith: code })) })
  child.kill()
  return {
    isolated: (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
    pageOpenErrno: onPage.openErrno,
    forked,
    written: new TextDecoder().decode(await fs.readFile('out.txt'))
  }
}

;(globalThis as unknown as { nativeAddonFilesE2e: { run: () => Promise<NativeAddonFileResults> } }).nativeAddonFilesE2e = {
  run: async () => { try { return await run() } catch (error) { return { error: String((error as Error)?.stack ?? error) } } }
}
