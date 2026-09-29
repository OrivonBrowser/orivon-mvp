// How the opt-in tests run a real program built outside this repository
// (ADR-0002): transpiled by jco as a port is told to, then run against the
// host with a fake network the test supplies and stdout captured.

import { readFileSync } from 'node:fs'
import { expect } from 'vitest'
import { jspiWebAssembly } from '../../../wasi/tests/support/jspi.js'
import type { SocketNet } from '../../addresses.js'
import { componentImports } from '../../imports.js'
import { InputStream, OutputStream } from '../../io.js'
import { runComponent, unmarkedAsyncImports } from '../../run.js'
import { instantiateFrom } from './component-fixture.js'
import { type Transpiled, loadJco } from './jco.js'

/** A network whose every call fails unless `overrides` supplies it. */
export function netWith (overrides: Partial<SocketNet>): SocketNet {
  const unused = async (): Promise<never> => { throw new Error('not reached in this mode') }
  return { connect: unused, listen: unused, udpBind: unused, lookup: unused, ...overrides } as SocketNet
}

/** The component at `path`, transpiled with exactly the imports the host answers asynchronously. */
export async function transpileProgram (path: string, name: string): Promise<Transpiled> {
  const program = (await loadJco()).transpile(readFileSync(path), name)
  expect(unmarkedAsyncImports(program.glue)).toEqual([])
  return program
}

/** Runs `program` as `name mode target`, with the app's directory at `/` through `fs`. */
export async function runProgram (program: Transpiled, name: string, mode: string, target: string, net: SocketNet, fs: unknown = {}): Promise<{ code: number, stdout: string }> {
  let stdout = ''
  const imports = componentImports({
    fs: fs as never,
    net,
    preopens: { '/': '/orivon/app', '.': '/orivon/app' },
    args: [name, mode, target],
    env: {},
    cwd: '/',
    stdin: new InputStream(async () => new Uint8Array(0)),
    stdout: new OutputStream(async (bytes) => { stdout += new TextDecoder().decode(bytes) }),
    stderr: new OutputStream(async () => {})
  })
  const code = await runComponent(instantiateFrom(program.glue, jspiWebAssembly), async (core) => await jspiWebAssembly.compile(program.cores.get(core) as Uint8Array<ArrayBuffer>), imports)
  return { code, stdout }
}
