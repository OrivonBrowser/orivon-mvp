// ADR-0016's Worker amendment, end to end: a real worker_threads thread
// blocked in Atomics.wait while fs.ts's *Sync exports run against a real
// disk, over a real MessagePort to this thread (which serves it, never the
// Worker itself -- worker/README.md's own rule, proven the same way
// worker/tests/sync-channel.test.ts proves readFileSync's blocking).

import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import esbuild from 'esbuild'
import { describe, expect, it } from 'vitest'
import { createRealDiskFs } from '../../tests/support/real-disk-fs.js'
import { serveOrivon } from '../../worker/orivon-server.js'

async function bundledEntry (): Promise<string> {
  const built = await esbuild.build({
    entryPoints: [join(import.meta.dirname, 'support', 'sync-fs-worker-entry.ts')],
    bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent'
  })
  return built.outputFiles[0]?.text ?? ''
}

describe('fs *Sync exports in a Worker of a cross-origin isolated app', () => {
  it('block a real thread on a real disk: mkdir, write, append, stat, lstat, readdir, copy, rename, read, access, unlink, mkdtemp, rmdir, rm', async () => {
    const disk = await createRealDiskFs()
    const { port1, port2 } = new MessageChannel()
    const server = serveOrivon(port1 as unknown as globalThis.MessagePort, disk.orivon)
    const worker = new Worker(await bundledEntry(), { eval: true, workerData: { port: port2 }, transferList: [port2 as never] })
    try {
      const result = await new Promise<Record<string, { value?: unknown, error?: { name: string, code?: string } }>>((resolve, reject) => {
        worker.once('message', resolve)
        worker.once('error', reject)
      })
      expect(result.mkdir).toEqual({ value: true })
      expect(result.write).toEqual({ value: true })
      expect(result.append).toEqual({ value: true })
      expect(result.stat).toEqual({ value: 'hello sync!'.length })
      expect(result.lstat).toEqual({ value: 'hello sync!'.length })
      expect(result.readdir).toEqual({ value: ['nested', 'notes.txt'] })
      expect(result.readdirTypes).toEqual({ value: [{ name: 'nested', dir: true }, { name: 'notes.txt', dir: false }] })
      expect(result.copy).toEqual({ value: true })
      expect(result.rename).toEqual({ value: true })
      expect(result.readBack).toEqual({ value: 'hello sync!' })
      expect(result.access).toEqual({ value: true })
      expect(result.unlink).toEqual({ value: true })
      expect((result.mkdtemp?.value as string | undefined)?.startsWith('dir/tmp-')).toBe(true)
      expect(result.rmdir).toEqual({ value: true })
      expect(result.rm).toEqual({ value: true })
      expect(result.missingAfterRm).toMatchObject({ error: { code: 'ENOENT' } })
    } finally {
      await worker.terminate()
      await server.dispose()
      await disk.cleanup()
    }
  })
})
