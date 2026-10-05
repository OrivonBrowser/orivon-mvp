// Bundled against the shim by ./e2e-native-addon.test.ts into the fixture
// app's page script: loads native addons the ways ported code does.

import { fork } from 'child_process'
import { createRequire } from 'module'
import { preloadAddon } from '../../src/shim/addon/index.js'

export interface NativeAddonResults {
  readonly small?: { answer: number, greet: string }
  readonly dlopen?: number | undefined
  readonly bigSync?: string
  readonly bigPreloaded?: number
  readonly missing?: string
  readonly forked?: unknown
  readonly error?: string
}

function failure (run: () => unknown): string {
  try {
    run()
    return 'loaded'
  } catch (error) {
    const { code, message } = error as { code?: string, message?: string }
    return `${code ?? ''} ${/preloadAddon/.test(message ?? '') ? 'names preloadAddon' : message ?? ''}`
  }
}

async function run (): Promise<NativeAddonResults> {
  const require = createRequire('/index.js')
  const small = require('./native/answer.node') as { answer: number, greet: string }
  const module = { exports: {} as { answer?: number } }
  ;(process as unknown as { dlopen: (module: object, filename: string) => void }).dlopen(module, '/native/answer.node')
  const bigSync = failure(() => require('./native/big.node'))
  await preloadAddon('/native/big.node')
  const bigPreloaded = (require('./native/big.node') as { answer: number }).answer
  const missing = failure(() => require('./native/missing.node'))
  const child = fork('/addon-child.js', [], { silent: true })
  const forked = await new Promise((resolve) => { child.once('message', resolve); child.once('exit', (code: number | null) => resolve({ exitedWith: code })) })
  child.kill()
  return { small: { answer: small.answer, greet: small.greet }, dlopen: module.exports.answer, bigSync, bigPreloaded, missing, forked }
}

;(globalThis as unknown as { nativeAddonE2e: { run: () => Promise<NativeAddonResults> } }).nativeAddonE2e = {
  run: async () => { try { return await run() } catch (error) { return { error: String((error as Error)?.stack ?? error) } } }
}
