import { Worker } from 'node:worker_threads'
import { describe, expect, it } from 'vitest'
import { bytesToHex } from 'viem'
import { buildFile } from '../../../../test/apps/swarm-gateway/encode.mjs'
import { cacAddress } from '../../swarm/chunk.js'
import { CHUNK_CHECK_WORKER_PLACEHOLDER, chunkCheckWorker } from '../../../../electron.vite.config.js'
import type { CheckAnswer } from '../chunk-check-pool.js'
import { builtChunkCheckWorker } from './chunk-check-worker.test-helpers.js'

const ENTRY = new URL('../entry.ts', import.meta.url).pathname

describe('the code of the chunk check thread', () => {
  it('loads nothing but the thread module, so it starts from a string wherever the host\'s own files are', async () => {
    const code = await builtChunkCheckWorker()
    const loads = [...code.matchAll(/require\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1])
    expect(loads).toEqual(['node:worker_threads'])
    expect(code).not.toMatch(/\bimport\s*\(|\bimport\.meta\b|__dirname|__filename/)
  })

  it('answers a request with whether the chunk is the one at its address', async () => {
    const store = new Map<string, Uint8Array>()
    const { ref } = buildFile(new TextEncoder().encode('a chunk'), store)
    const chunk = store.get(ref)!
    expect(bytesToHex(cacAddress(chunk)).slice(2)).toBe(ref)
    const worker = new Worker(await builtChunkCheckWorker(), { eval: true })
    try {
      const answers = new Map<number, boolean>()
      const done = new Promise<void>((resolve) => {
        worker.on('message', (answer: CheckAnswer) => {
          answers.set(answer.id, answer.ok)
          if (answers.size === 3) resolve()
        })
      })
      const flipped = new Uint8Array(chunk)
      flipped[9] = flipped[9]! ^ 1
      worker.postMessage({ id: 1, address: ref, chunk: new Uint8Array(chunk) })
      worker.postMessage({ id: 2, address: ref, chunk: flipped })
      worker.postMessage({ id: 3, address: ref, chunk: new Uint8Array() })
      await done
      expect([...answers]).toEqual([[1, true], [2, false], [3, false]])
    } finally {
      await worker.terminate()
    }
  })
})

describe('the main build\'s chunkCheckWorker plugin', () => {
  const transform = async (code: string, id = ENTRY): Promise<string | undefined> => {
    const run = chunkCheckWorker().transform as (code: string, id: string) => Promise<{ code: string } | null>
    return (await run(code, id))?.code
  }

  it('puts the thread\'s code into the host\'s entry as a string, in place of the name it is known by', async () => {
    const inlined = await transform(`const worker = ${CHUNK_CHECK_WORKER_PLACEHOLDER}\nexport { worker }`)
    expect(inlined).toBeDefined()
    expect(inlined).not.toContain(CHUNK_CHECK_WORKER_PLACEHOLDER)
    const worker = /^const worker = (".*")\n/s.exec(inlined!)?.[1]
    expect(typeof JSON.parse(worker!)).toBe('string')
    expect(JSON.parse(worker!)).toContain('node:worker_threads')
  }, 60_000)

  it('leaves every other file alone', async () => {
    expect(await transform(`const worker = ${CHUNK_CHECK_WORKER_PLACEHOLDER}`, new URL('../service.ts', import.meta.url).pathname)).toBeUndefined()
  })

  it('fails the build when the entry names it not once', async () => {
    await expect(transform('export {}')).rejects.toThrow(/exactly once, not 0 times/)
    await expect(transform(`${CHUNK_CHECK_WORKER_PLACEHOLDER}; ${CHUNK_CHECK_WORKER_PLACEHOLDER}`)).rejects.toThrow(/exactly once, not 2 times/)
  })
})
