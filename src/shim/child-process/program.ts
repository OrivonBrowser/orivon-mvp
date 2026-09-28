// What `spawn(command)` runs: a WebAssembly program from the app's own
// origin, at `command` or at `command` + `.wasm`, compiled once per URL. A
// WASI 0.2 component runs as the output jco transpiled it to, beside it
// under `<command>.p2/`. A native program is refused by name (ADR-0040); a
// missing one is Node's ENOENT, so a library's "is the tool installed" check
// takes its ordinary branch.

import { transpileCommand, unmarkedAsyncImports } from '../wasi-p2/run.js'
import type { SpawnProgram } from '../worker/protocol.js'

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d]
/** The version field after the magic: 1 for a core module, layer 1 version 0xd for a component. */
const COMPONENT_VERSION = [0x0d, 0x00, 0x01, 0x00]

/** The first bytes of the executable formats a port might ship by mistake. */
const NATIVE_MAGICS: ReadonlyArray<readonly number[]> = [
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x4d, 0x5a], // PE (MZ)
  [0xcf, 0xfa, 0xed, 0xfe], [0xce, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe], // Mach-O
  [0x23, 0x21] // #! script
]

const compiled = new Map<string, Promise<WebAssembly.Module>>()

export interface SpawnError extends Error {
  code: string
  errno: number
  syscall: string
  path: string
  spawnargs: readonly string[]
  reason?: 'excluded'
}

function startsWith (bytes: Uint8Array, magic: readonly number[]): boolean {
  return magic.every((byte, index) => bytes[index] === byte)
}

export function spawnError (code: 'ENOENT' | 'ENOEXEC' | 'EACCES', file: string, args: readonly string[], detail?: string): SpawnError {
  const errno = { ENOENT: -2, ENOEXEC: -8, EACCES: -13 }[code]
  const message = `spawn ${file} ${code}${detail === undefined ? '' : `: ${detail}`}`
  return Object.assign(new Error(message), { code, errno, syscall: `spawn ${file}`, path: file, spawnargs: args })
}

/** The URLs `command` may name on the app's origin, in the order they are tried. */
export function programUrls (command: string, origin: string): string[] {
  const base = new URL(command.startsWith('/') ? command : `/${command}`, origin)
  if (base.origin !== new URL(origin).origin) return []
  const exact = base.href
  return exact.endsWith('.wasm') ? [exact] : [exact, `${exact}.wasm`]
}

async function fetchProgram (urls: readonly string[], command: string, args: readonly string[]): Promise<{ url: string, bytes: Uint8Array } | undefined> {
  for (const url of urls) {
    const response = await fetch(url).catch(() => undefined)
    if (response?.ok !== true) continue
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (startsWith(bytes, WASM_MAGIC)) return { url, bytes }
    if (NATIVE_MAGICS.some((magic) => startsWith(bytes, magic))) {
      throw Object.assign(spawnError('ENOEXEC', command, args, `${command} is a native program, and an app runs only WebAssembly programs`), { reason: 'excluded' as const })
    }
  }
  return undefined
}

/** Where jco's output for the component at `url` is: `tool.wasm` is run from `tool.p2/tool.js`. */
function componentGlueUrl (url: string): string {
  const base = url.replace(/\.wasm$/, '')
  return `${base}.p2/${base.slice(base.lastIndexOf('/') + 1)}.js`
}

/** The component's jco output, checked to mark every import the WASI 0.2 host answers asynchronously. */
async function loadComponent (url: string, command: string, args: readonly string[], found: boolean): Promise<SpawnProgram | undefined> {
  const glue = componentGlueUrl(url)
  const response = await fetch(glue).catch(() => undefined)
  if (response?.ok !== true) {
    if (!found) return undefined
    throw spawnError('ENOEXEC', command, args, `${command} is a WASI 0.2 component, which runs here as jco's output beside it: ${transpileCommand(new URL(url).pathname)}`)
  }
  const unmarked = unmarkedAsyncImports(await response.text())
  if (unmarked.length > 0) {
    throw spawnError('ENOEXEC', command, args, `${command}'s jco output lowers ${unmarked.join(', ')} synchronously, and the host answers them asynchronously: ${transpileCommand(new URL(url).pathname)}`)
  }
  return { kind: 'component', glue, base: new URL('.', glue).href }
}

function isComponent (bytes: Uint8Array): boolean {
  return COMPONENT_VERSION.every((byte, index) => bytes[4 + index] === byte)
}

/** Resolves `command` and compiles a preview1 program, or finds a component's jco output; rejects with a Node-shaped spawn error. */
export async function loadProgram (command: string, args: readonly string[], origin: string = globalThis.location.origin): Promise<SpawnProgram> {
  const urls = programUrls(command, origin)
  if (urls.length === 0) throw spawnError('EACCES', command, args, 'a program must come from the app\'s own origin')
  const cached = urls.map((url) => compiled.get(url)).find((entry) => entry !== undefined)
  if (cached !== undefined) return { kind: 'core', module: await cached }
  const fetched = await fetchProgram(urls, command, args)
  if (fetched === undefined || isComponent(fetched.bytes)) {
    const component = await loadComponent(fetched?.url ?? urls[urls.length - 1] as string, command, args, fetched !== undefined)
    if (component === undefined) throw spawnError('ENOENT', command, args)
    return component
  }
  const { url, bytes } = fetched
  const module = WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>)
  compiled.set(url, module)
  module.catch(() => compiled.delete(url))
  try {
    return { kind: 'core', module: await module }
  } catch (error) {
    throw spawnError('ENOEXEC', command, args, `not a valid WebAssembly program: ${String(error)}`)
  }
}
