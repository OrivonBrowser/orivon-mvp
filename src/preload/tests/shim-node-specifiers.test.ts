import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { isShimImporter, root, shimNodeSpecifiers } from '../../../electron.vite.config.js'

const SHIM_IMPORTER = resolve(root, 'src/shim/wasi/fds.ts')
const SHIM_TEST_IMPORTER = resolve(root, 'src/shim/wasi/tests/fds.test.ts')
const PRELOAD_IMPORTER = resolve(root, 'src/preload/child-host.ts')
const PACKAGE_IMPORTER = resolve(root, 'node_modules/readable-stream/lib/internal/streams/buffer_list.js')

// isShimImporter is a thin wrapper around is-shim-source.ts's isShimSource,
// bound to this repository's real root; is-shim-source.test.ts exercises
// that function's own edge cases (a checkout root under a `tests` or
// `src/shim` directory, Windows-style paths) directly, with a root the test
// controls -- this just proves the wrapper is wired to the real one.
describe('isShimImporter', () => {
  it('is true only for a file under src/shim/, never its own tests', () => {
    expect(isShimImporter(SHIM_IMPORTER)).toBe(true)
    expect(isShimImporter(SHIM_TEST_IMPORTER)).toBe(false)
    expect(isShimImporter(PRELOAD_IMPORTER)).toBe(false)
    expect(isShimImporter(PACKAGE_IMPORTER)).toBe(false)
    expect(isShimImporter(undefined)).toBe(false)
  })
})

interface FakeContext { resolve: ReturnType<typeof vi.fn> }
type ResolveId = (this: FakeContext, source: string, importer?: string, options?: object) => unknown

describe('the preload build\'s shimNodeSpecifiers plugin', () => {
  /** A minimal stand-in for Rollup's PluginContext -- only `resolve` is used by the hook. */
  function fakeContext (resolved: unknown = { id: 'resolved' }): FakeContext {
    return { resolve: vi.fn(async () => resolved) }
  }

  /** The hook itself, whichever of Rollup's two ObjectHook shapes it happens to be -- this
   * plugin only ever returns the plain-function shape, so a runtime cast is enough. */
  function resolveIdOf (plugin: ReturnType<typeof shimNodeSpecifiers>): ResolveId {
    return plugin.resolveId as unknown as ResolveId
  }

  it('resolves a bare Node specifier imported by shim code through module-map.ts\'s table', async () => {
    const ctx = fakeContext()
    const result = await resolveIdOf(shimNodeSpecifiers()).call(ctx, 'path', SHIM_IMPORTER, { isEntry: false })

    expect(ctx.resolve).toHaveBeenCalledTimes(1)
    const [target, importer, options] = ctx.resolve.mock.calls[0] as [string, string, Record<string, unknown>]
    expect(target).toMatch(/src[/\\]shim[/\\]polyfills[/\\]path\.js$/)
    expect(importer).toBe(SHIM_IMPORTER)
    expect(options).toMatchObject({ skipSelf: true, isEntry: false })
    expect(result).toEqual({ id: 'resolved' })
  })

  it('resolves the same specifier written as node:path', async () => {
    const ctx = fakeContext()
    await resolveIdOf(shimNodeSpecifiers()).call(ctx, 'node:path', SHIM_IMPORTER)
    expect(ctx.resolve).toHaveBeenCalledTimes(1)
  })

  it('leaves a non-shim importer alone, even for a specifier the table maps', async () => {
    const ctx = fakeContext()
    const result = await resolveIdOf(shimNodeSpecifiers()).call(ctx, 'path', PRELOAD_IMPORTER)

    expect(ctx.resolve).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })

  it('leaves a specifier the table does not map alone, even for a shim importer', async () => {
    const ctx = fakeContext()
    const result = await resolveIdOf(shimNodeSpecifiers()).call(ctx, 'left-pad', SHIM_IMPORTER)

    expect(ctx.resolve).not.toHaveBeenCalled()
    expect(result).toBeNull()
  })

  it('resolves a builtin a bundled package asks for when a sandboxed preload could not require it', async () => {
    // readable-stream, which the shim's stream polyfill brings in, requires 'buffer' and 'util' itself.
    for (const specifier of ['buffer', 'util']) {
      const ctx = fakeContext()
      await resolveIdOf(shimNodeSpecifiers()).call(ctx, specifier, PACKAGE_IMPORTER)
      expect(ctx.resolve, specifier).toHaveBeenCalledTimes(1)
    }
  })

  it('leaves a package\'s events, timers and url to the sandboxed preload\'s own require', async () => {
    for (const specifier of ['events', 'timers', 'url']) {
      const ctx = fakeContext()
      expect(await resolveIdOf(shimNodeSpecifiers()).call(ctx, specifier, PACKAGE_IMPORTER), specifier).toBeNull()
      expect(ctx.resolve).not.toHaveBeenCalled()
    }
  })

  it('leaves a relative or absolute import alone', async () => {
    const ctx = fakeContext()
    expect(await resolveIdOf(shimNodeSpecifiers()).call(ctx, './fds.js', SHIM_IMPORTER)).toBeNull()
    expect(ctx.resolve).not.toHaveBeenCalled()
  })
})
