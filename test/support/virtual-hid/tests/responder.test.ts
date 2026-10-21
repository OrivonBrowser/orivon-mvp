import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { echoResponder, loadResponder, serialQueue } from '../responder.ts'

const noDevice = { replug: () => {} }

describe('responders', () => {
  it('echoes a report back unchanged', async () => {
    const sent: number[][] = []
    await echoResponder(Uint8Array.from([1, 2]), (r) => { sent.push([...r]) }, noDevice)
    expect(sent).toEqual([[1, 2]])
  })

  it('answers reports in arrival order while an earlier one is still being answered', async () => {
    const sent: number[] = []
    const slowFirst = async (report: Uint8Array, send: (r: Uint8Array) => void): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, report.at(0) === 1 ? 40 : 0))
      send(report)
    }
    const queue = serialQueue(slowFirst, (r) => { sent.push(r.at(0) ?? -1) }, () => {})
    void queue(Uint8Array.from([1]))
    void queue(Uint8Array.from([2]))
    await queue(Uint8Array.from([3]))
    expect(sent).toEqual([1, 2, 3])
  })

  it('hands each handler the device, so it can replug after answering', async () => {
    const calls: string[] = []
    const replugAfterTwo = (report: Uint8Array, send: (r: Uint8Array) => void, device: { replug: () => void }): void => {
      send(report)
      if (report.at(0) === 2) device.replug()
    }
    const queue = serialQueue(replugAfterTwo, (r) => { calls.push(`send ${r.at(0) ?? -1}`) }, () => {}, { replug: () => { calls.push('replug') } })
    void queue(Uint8Array.from([1]))
    await queue(Uint8Array.from([2]))
    expect(calls).toEqual(['send 1', 'send 2', 'replug'])
  })

  it('reports a failing handler and keeps answering', async () => {
    const errors: unknown[] = []
    const sent: number[] = []
    const queue = serialQueue(
      (report, send) => { if (report.at(0) === 1) throw new Error('boom'); send(report) },
      (r) => { sent.push(r.at(0) ?? -1) },
      (error) => errors.push(error)
    )
    void queue(Uint8Array.from([1]))
    await queue(Uint8Array.from([2]))
    expect(errors).toHaveLength(1)
    expect(sent).toEqual([2])
  })

  it('loads a module whose default export resolves late', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vhid-responder-'))
    try {
      const file = join(dir, 'late.ts')
      writeFileSync(file, 'export default new Promise((resolve) => setTimeout(() => resolve((r: Uint8Array, send: (r: Uint8Array) => void) => { send(r.slice(1)) }), 10))')
      const handler = await loadResponder(file)
      const sent: number[][] = []
      await handler(Uint8Array.from([9, 4]), (r) => { sent.push([...r]) }, noDevice)
      expect(sent).toEqual([[4]])
      writeFileSync(join(dir, 'bad.ts'), 'export default 5')
      await expect(loadResponder(join(dir, 'bad.ts'))).rejects.toThrow(/default/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
