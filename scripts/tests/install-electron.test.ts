import { access, chmod, link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SENTINEL } from '@electron/fuses/dist/constants'
import {
  CHECKOUT_FUSES,
  electronBinaryPath,
  electronInstallPlan,
  resolveInstaller,
  setCheckoutFuses
} from '../install-electron.mjs'

/** A resolver that always finds the installer, for the env-var cases. */
const found = (): string => '/somewhere/node_modules/electron/install.js'

/** A resolver standing in for `npm install --omit=dev`. */
const missing = (): undefined => undefined

describe('electronInstallPlan', () => {
  it('installs when nothing opts out and electron is present', () => {
    expect(electronInstallPlan({}, found)).toEqual({
      action: 'install',
      installer: '/somewhere/node_modules/electron/install.js'
    })
  })

  it('skips when ELECTRON_SKIP_BINARY_DOWNLOAD is set', () => {
    expect(electronInstallPlan({ ELECTRON_SKIP_BINARY_DOWNLOAD: '1' }, found))
      .toEqual({ action: 'skip' })
  })

  // An unset variable and one exported as empty must not mean different
  // things: `ELECTRON_SKIP_BINARY_DOWNLOAD=` in a CI matrix is how a skip
  // gets switched off, and it would be read as a skip by a bare truthiness
  // test on the string.
  it('treats an empty value as not set', () => {
    expect(electronInstallPlan({ ELECTRON_SKIP_BINARY_DOWNLOAD: '' }, found).action)
      .toBe('install')
  })

  // The hook runs for `npm install --omit=dev` too, and electron is a
  // devDependency. Failing there would break an install that never wanted the
  // binary in the first place.
  it('reports absent, not a failure, when electron is not installed', () => {
    expect(electronInstallPlan({}, missing)).toEqual({ action: 'absent' })
  })

  it('does not consult the resolver when the skip is set', () => {
    let called = false
    const spy = (): string => { called = true; return 'x' }
    electronInstallPlan({ ELECTRON_SKIP_BINARY_DOWNLOAD: '1' }, spy)
    expect(called).toBe(false)
  })
})

describe('resolveInstaller', () => {
  it('finds electron/install.js in this tree', () => {
    expect(resolveInstaller()).toMatch(/node_modules[/\\]electron[/\\]install\.js$/)
  })

  it('returns undefined rather than throwing when the package is absent', () => {
    expect(resolveInstaller('file:///nowhere/that/exists/x.mjs')).toBeUndefined()
  })
})

interface Fuses { file: number, cookie: number }

/** The file-protocol and cookie-encryption fuses as Electron ships them, and as a package has them. */
const SHIPPED: Fuses = { file: 49, cookie: 48 }
const PACKAGED: Fuses = { file: 48, cookie: 49 }

/** A binary-shaped file: filler, Electron's sentinel, version 1, an eight-fuse wire. */
function fakeBinary ({ file, cookie }: Fuses): Buffer {
  return Buffer.concat([
    Buffer.alloc(200, 0x41),
    Buffer.from(SENTINEL),
    Buffer.from([1, 8, 48, cookie, 48, 48, 49, 49, 48, file]),
    Buffer.alloc(200, 0x42)
  ])
}

function fusesOf (bytes: Buffer): Fuses {
  const wire = bytes.indexOf(SENTINEL) + SENTINEL.length + 2
  return { file: bytes[wire + 7] as number, cookie: bytes[wire + 1] as number }
}

/** `electronFuses` in electron-builder.yml: what a package's binary has. */
async function packagedFuses (): Promise<Record<string, boolean>> {
  const yml = await readFile(join(import.meta.dirname, '..', '..', 'electron-builder.yml'), 'utf8')
  const block = /^electronFuses:\n((?:[ \t]+.*\n|\n)*)/m.exec(yml)?.[1] ?? ''
  return Object.fromEntries([...block.matchAll(/^[ \t]+(\w+):[ \t]*(true|false)\b/gm)].map(([, name, on]) => [name, on === 'true']))
}

describe('CHECKOUT_FUSES', () => {
  it('sets each fuse as a package sets it', async () => {
    const packaged = await packagedFuses()
    for (const [name, on] of Object.entries(CHECKOUT_FUSES)) expect(packaged[name], name).toBe(on)
  })

  // A run from source and an installed package share one profile: a binary that does not encrypt
  // cookies reads none of those the other wrote, and every site the package was signed in to is signed out.
  it('encrypts cookies whenever a package does', async () => {
    const packaged = await packagedFuses()
    expect(packaged['enableCookieEncryption']).toBe(true)
    expect(CHECKOUT_FUSES.enableCookieEncryption).toBe(packaged['enableCookieEncryption'])
  })
})

describe('setCheckoutFuses', () => {
  let root: string
  let binary: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'orivon-fuse-install-'))
    const dist = join(root, 'checkout', 'node_modules', 'electron', 'dist')
    await mkdir(dist, { recursive: true })
    binary = join(dist, 'electron')
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  const checkout = (): string => join(root, 'checkout')

  it('writes nothing when the fuses are already set as a package sets them', async () => {
    await writeFile(binary, fakeBinary(PACKAGED))
    const before = await stat(binary)
    const result = await setCheckoutFuses({ binary, checkoutRoot: checkout(), platform: 'linux' })
    expect(result.status).toBe('already-set')
    expect((await stat(binary)).ino).toBe(before.ino)
    expect((await stat(binary)).mtimeMs).toBe(before.mtimeMs)
  })

  // A worktree's node_modules is a hard-linked copy of another checkout's: writing the
  // binary in place would turn that checkout's fuse off too.
  it('renames a new file over the binary, leaving a hard-linked twin untouched', async () => {
    await writeFile(binary, fakeBinary(SHIPPED))
    await chmod(binary, 0o755)
    const twin = join(root, 'twin')
    await link(binary, twin)
    const before = await stat(binary)

    const result = await setCheckoutFuses({ binary, checkoutRoot: checkout(), platform: 'linux' })

    expect(result.status).toBe('flipped')
    const after = await stat(binary)
    expect(after.ino).not.toBe(before.ino)
    expect(after.mode & 0o777).toBe(0o755)
    expect(fusesOf(await readFile(binary))).toEqual(PACKAGED)
    const twinAfter = await stat(twin)
    expect(twinAfter.ino).toBe(before.ino)
    expect(fusesOf(await readFile(twin))).toEqual(SHIPPED)
    await expect(access(`${binary}.fuse-tmp`)).rejects.toThrow()
  })

  // A checkout's binary whose file-protocol fuse was turned off on its own: cookie encryption is still Electron's off.
  it('turns cookie encryption on when only the file-protocol fuse is set', async () => {
    await writeFile(binary, fakeBinary({ file: 48, cookie: 48 }))
    const result = await setCheckoutFuses({ binary, checkoutRoot: checkout(), platform: 'linux' })
    expect(result.status).toBe('flipped')
    expect(fusesOf(await readFile(binary))).toEqual(PACKAGED)
  })

  it('removes the temporary file and keeps the binary when the flip fails', async () => {
    const original = fakeBinary(SHIPPED)
    await writeFile(binary, original)
    const result = await setCheckoutFuses({
      binary,
      checkoutRoot: checkout(),
      platform: 'linux',
      flip: async (path: string) => { await writeFile(path, 'half'); throw new Error('disk full') }
    })
    expect(result.status).toBe('failed')
    expect(result.reason).toMatch(/disk full/)
    expect(await readFile(binary)).toEqual(original)
    await expect(access(`${binary}.fuse-tmp`)).rejects.toThrow()
  })

  it('refuses a dist/ that lies outside the checkout', async () => {
    const outside = join(root, 'elsewhere', 'electron')
    await mkdir(join(root, 'elsewhere'), { recursive: true })
    await writeFile(outside, fakeBinary(SHIPPED))
    const result = await setCheckoutFuses({ binary: outside, checkoutRoot: checkout(), platform: 'linux' })
    expect(result.status).toBe('refused')
    expect(result.reason).toMatch(/outside/)
    expect(fusesOf(await readFile(outside))).toEqual(SHIPPED)
  })

  it('refuses a dist/ reached through a symlink out of the checkout', async () => {
    const real = join(root, 'shared', 'dist')
    await mkdir(real, { recursive: true })
    await writeFile(join(real, 'electron'), fakeBinary(SHIPPED))
    const linked = join(checkout(), 'linked-dist')
    await symlink(real, linked)
    const result = await setCheckoutFuses({ binary: join(linked, 'electron'), checkoutRoot: checkout(), platform: 'linux' })
    expect(result.status).toBe('refused')
    expect(fusesOf(await readFile(join(real, 'electron')))).toEqual(SHIPPED)
  })

  // The flip is measured on Linux only (A394); a macOS framework needs a re-sign and Windows
  // refuses a rename over a running .exe, so neither is touched until it is measured.
  it.each(['darwin', 'win32'] as const)('refuses on %s and leaves the binary alone', async (platform) => {
    const original = fakeBinary(SHIPPED)
    await writeFile(binary, original)
    const result = await setCheckoutFuses({ binary, checkoutRoot: checkout(), platform })
    expect(result.status).toBe('refused')
    expect(result.reason).toMatch(/A394/)
    expect(await readFile(binary)).toEqual(original)
  })

  it('reports a binary with no fuse wire as failed, not as off', async () => {
    await writeFile(binary, Buffer.alloc(500, 0x41))
    const result = await setCheckoutFuses({ binary, checkoutRoot: checkout(), platform: 'linux' })
    expect(result.status).toBe('failed')
    await expect(access(`${binary}.fuse-tmp`)).rejects.toThrow()
  })
})

describe('electronBinaryPath', () => {
  it('joins path.txt onto dist/ beside the installer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'orivon-fuse-pathtxt-'))
    try {
      await writeFile(join(dir, 'path.txt'), 'electron')
      expect(electronBinaryPath(join(dir, 'install.js'))).toBe(join(dir, 'dist', 'electron'))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('is undefined when path.txt is missing', () => {
    expect(electronBinaryPath('/nowhere/at/all/install.js')).toBeUndefined()
  })
})

describe('electron-builder.yml', () => {
  it('turns the packaged binary file fuse off', async () => {
    const yml = await readFile(join(import.meta.dirname, '..', '..', 'electron-builder.yml'), 'utf8')
    expect(yml).toMatch(/^ {2}grantFileProtocolExtraPrivileges: false$/m)
  })
})

describe('package.json', () => {
  // A script that launches this checkout's binary runs it on the profile a package shares: launched before the
  // fuses are set, it deletes every sign-in the package saved there.
  it('sets the fuses before any script launches the binary', async () => {
    const pkg = JSON.parse(await readFile(join(import.meta.dirname, '..', '..', 'package.json'), 'utf8')) as { scripts: Record<string, string> }
    const launching = Object.entries(pkg.scripts).filter(([, command]) => /electron-vite preview|(^|\s)electron\s/.test(command))
    expect(launching.map(([name]) => name)).toContain('start')
    for (const [name, command] of launching) {
      expect(command.split('&&')[0]?.trim(), name).toBe('node scripts/install-electron.mjs --fuses')
    }
  })
})
