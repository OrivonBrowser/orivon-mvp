import { describe, expect, it } from 'vitest'
import { rejection } from '../handles/tests/handles.test-helpers.js'
import { APP, baseDeps, manifestWith, unusedFsExtras } from './index.test-helpers.js'
import { createBroker } from '../index.js'
import type { CreateBrokerOptions, Dial } from '../broker-contracts.js'

// createBroker's error-mapping seam -- split out of index.test.ts under
// code-guidelines.md's 800-line test limit (a pure move: no behaviour
// changed, so the diff reads as one). contracts/errors.ts: "An app may
// switch on this exhaustively and treat an unrecognised value as a bug."
// stubResolve and the default stubFs used elsewhere in index.test.ts can
// never reject, so nothing in that file's own suite catches this -- these
// stubs reject on purpose, the way a real DNS failure or a real ENOENT
// would.

describe('raw I/O errors are mapped onto the closed OrivonErrorCode enum (MAJOR)', () => {
  it('maps a dial ECONNREFUSED to unreachable, carrying the errno as platformCode', async () => {
    const dial: Dial = async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:443'), { code: 'ECONNREFUSED' })
    }
    const broker = createBroker(baseDeps({ dial }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['93.184.216.34:443'] } } }))
    await broker.grant(APP, 'tcp.connect', ['93.184.216.34:443'])

    const error = await rejection(broker.net.connect(APP, { host: '93.184.216.34', port: 443 }))

    expect(error.code).toBe('unreachable')
    expect(error.platformCode).toBe('ECONNREFUSED')
    // The original message is never forwarded -- only the Node convention
    // (`err.code`) survives, via platformCode.
    expect(error.message).not.toContain('ECONNREFUSED')
  })

  it('maps a resolve ENOTFOUND to unreachable', async () => {
    const resolve = async (): Promise<readonly string[]> => {
      throw Object.assign(new Error('getaddrinfo ENOTFOUND example.com'), { code: 'ENOTFOUND' })
    }
    const broker = createBroker(baseDeps({ resolve }))
    broker.registerApp(APP, manifestWith({ net: { tcp: { connect: ['example.com:443'] } } }))
    await broker.grant(APP, 'tcp.connect', ['example.com:443'])

    const error = await rejection(broker.net.connect(APP, { host: 'example.com', port: 443 }))

    expect(error.code).toBe('unreachable')
    expect(error.platformCode).toBe('ENOTFOUND')
  })

  it('maps an fs.readFile ENOENT to notFound, and never forwards the confined path (info leak)', async () => {
    const fs: CreateBrokerOptions['fs'] = {
      rootFor: () => '/apps/app',
      realpathSync: (p) => p,
      readFile: async () => {
        throw Object.assign(new Error("ENOENT: no such file or directory, open '/apps/app/missing.txt'"), { code: 'ENOENT' })
      },
      writeFile: async () => {},
      ...unusedFsExtras()
    }
    const broker = createBroker(baseDeps({ fs }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    await broker.grant(APP, 'fs', [])

    const error = await rejection(broker.fs.readFile(APP, 'missing.txt'))

    expect(error.code).toBe('notFound')
    expect(error.platformCode).toBe('ENOENT')
    // security-model.md T13b: the confinement root is sha256(canonical
    // origin) under the app data directory. Handing the app its own full
    // on-disk path tells it exactly where that boundary sits.
    expect(error.message).not.toContain('/apps/app')
    expect(error.message).not.toContain('missing.txt')
  })

  it('maps an fs EACCES to denied, which never carries a platformCode', async () => {
    const fs: CreateBrokerOptions['fs'] = {
      rootFor: () => '/apps/app',
      realpathSync: (p) => p,
      readFile: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      },
      writeFile: async () => {},
      ...unusedFsExtras()
    }
    const broker = createBroker(baseDeps({ fs }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    await broker.grant(APP, 'fs', [])

    const error = await rejection(broker.fs.readFile(APP, 'secret.txt'))

    expect(error.code).toBe('denied')
    expect(error.platformCode).toBeUndefined()
  })

  it('maps an unrecognised errno to internal, fail-closed', async () => {
    const fs: CreateBrokerOptions['fs'] = {
      rootFor: () => '/apps/app',
      realpathSync: (p) => p,
      readFile: async () => {
        throw Object.assign(new Error('EWEIRD: not in the mapping table'), { code: 'EWEIRD' })
      },
      writeFile: async () => {},
      ...unusedFsExtras()
    }
    const broker = createBroker(baseDeps({ fs }))
    broker.registerApp(APP, manifestWith({ fs: {} }))
    await broker.grant(APP, 'fs', [])

    const error = await rejection(broker.fs.readFile(APP, 'a.txt'))

    expect(error.code).toBe('internal')
    expect(error.platformCode).toBe('EWEIRD')
  })
})
