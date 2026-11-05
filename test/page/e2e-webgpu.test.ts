// WebGPU in a tab, per platform: what a page gets is pinned here so a Chromium update that changes it fails a
// check instead of a user's local-model app. The page asks for an adapter the way any site does; the main process
// reports Chromium's own feature status. Docs: docs/planning/webgpu-plan.md, step 1.
import type { ElectronApplication } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { html, launchShell, QA_TEST_TIMEOUT_MS, seedSiteAnswers, startServer, visitWithoutPage } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'

let server: FixtureServer

beforeAll(async () => {
  server = await startServer((_request, response) => { html(response, '<!doctype html><title>gpu</title><p>gpu</p>') })
})

afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface PageSeen {
  readonly secure: boolean
  readonly hasGpu: boolean
  /** null: the page was refused an adapter. */
  readonly adapter: { readonly vendor: string, readonly architecture: string, readonly fallback: boolean } | null
  /** One doubling dispatch read back, or null when there was no adapter. */
  readonly compute: readonly number[] | null
}

/** A page's own ask: an adapter, then one compute dispatch whose result is read back. */
const PAGE_PROBE = `(async () => {
  const out = { secure: isSecureContext, hasGpu: 'gpu' in navigator, adapter: null, compute: null }
  if (!navigator.gpu) return out
  const adapter = await navigator.gpu.requestAdapter()
  if (adapter === null) return out
  const info = adapter.info
  out.adapter = { vendor: info.vendor, architecture: info.architecture, fallback: info.isFallbackAdapter === true }
  const device = await adapter.requestDevice()
  const input = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(input, 0, new Float32Array([1, 2, 3, 4]))
  const read = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const module = device.createShaderModule({ code: '@group(0) @binding(0) var<storage, read_write> v: array<f32>; @compute @workgroup_size(4) fn main(@builtin(global_invocation_id) id: vec3u) { v[id.x] = v[id.x] * 2.0; }' })
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } })
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: input } }] })
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(1); pass.end()
  encoder.copyBufferToBuffer(input, 0, read, 0, 16)
  device.queue.submit([encoder.finish()])
  await read.mapAsync(GPUMapMode.READ)
  out.compute = Array.from(new Float32Array(read.getMappedRange()))
  return out
})()`

/** The statuses Chromium reports that decide WebGPU, as `app.getGPUFeatureStatus()` words them. */
type Status = Readonly<Record<string, string>>

async function seenIn (app: ElectronApplication, origin: string): Promise<{ page: PageSeen, status: Status }> {
  const page = await app.evaluate(async ({ webContents }, { target, script }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(target))
    if (contents === undefined) throw new Error('no tab on the fixture page')
    return await contents.executeJavaScript(script) as unknown
  }, { target: origin, script: PAGE_PROBE })
  const status = await app.evaluate(({ app: electron }) => electron.getGPUFeatureStatus() as unknown as Record<string, string>)
  return { page: page as PageSeen, status }
}

const DOUBLED = [2, 4, 6, 8]

it('gives a page the WebGPU this platform is known to give', async () => {
  // A website is asked before its page keeps an adapter (ADR-0106): the fixture's own origin is allowed, so no question holds the probe.
  const { app, chrome } = await launchShell({ seedProfile: async (dir: string) => { await seedSiteAnswers(dir, { [server.origin]: { webgpu: 'allow' } }) } })
  try {
    await visitWithoutPage(app, chrome, `${server.origin}/`)
    const { page, status } = await seenIn(app, server.origin)
    // Chromium refuses GPU info once it has fallen back to software, which is itself the answer on such a platform.
    const gpus = await app.evaluate(async ({ app: electron }) => {
      try { return (await electron.getGPUInfo('basic') as { gpuDevice?: unknown }).gpuDevice } catch (error) { return String(error) }
    })
    console.log(`WEBGPU-SEEN ${process.platform} ${JSON.stringify({ page, status, gpus })}`)

    // On every platform: a page on a loopback origin sees the API, and an adapter comes only where Chromium says WebGPU
    // is on (the status can say on and still give none, so the reverse is not asserted).
    expect(page.secure).toBe(true)
    expect(page.hasGpu).toBe(true)
    if (page.adapter !== null) expect(status['webgpu']).toBe('enabled')
    expect(page.compute).toEqual(page.adapter === null ? null : DOUBLED)

    if (process.platform === 'linux') {
      // The launch runs on a virtual display with no GPU behind it, and Chromium offers a page no adapter on one.
      expect(page.adapter).toBeNull()
      expect(status['webgpu']).not.toBe('enabled')
      expect(status['webgpu_on_vk_via_gl_interop']).not.toBe('enabled')
    } else if (process.platform === 'darwin') {
      // Metal: a Mac, and a runner's virtual device, answer an adapter.
      expect(page.adapter).not.toBeNull()
      expect(status['webgpu']).toBe('enabled')
      expect(status['gpu_compositing']).toBe('enabled')
    } else if (process.platform === 'win32' && process.env['CI'] === 'true') {
      // A GitHub runner has only Microsoft's Basic Render Driver: Chromium composites in software and offers no adapter.
      // A computer with a GPU answers one, which is why this is pinned on the runner alone.
      expect(page.adapter).toBeNull()
      expect(status['webgpu']).toBe('unavailable_software')
    }
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
