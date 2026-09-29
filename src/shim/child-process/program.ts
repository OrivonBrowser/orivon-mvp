// What `spawn(command)` runs: a WASI 0.2 component, as the output jco
// transpiled it to under `<command>.p2/`, or else a preview1 program at
// `command` or `command` + `.wasm`, compiled once per URL. Both are looked up
// once per page, since an app's files are fixed for its pinned version. A
// native program is refused by name (ADR-0040); a missing one is Node's
// ENOENT, so a library's "is the tool installed" check takes its ordinary
// branch.

import { isJcoOutput, transpileCommand, unmarkedAsyncImports } from '../wasi-p2/run.js'
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
/** A component's jco output by its URL, or undefined where there is none. */
const components = new Map<string, Promise<SpawnProgram | undefined>>()

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

/** Where jco's output for the program at `url` is: `tool` and `tool.wasm` are run from `tool.p2/tool.js`. */
function componentGlueUrl (url: string): string {
  const base = url.replace(/\.wasm$/, '')
  return `${base}.p2/${base.slice(base.lastIndexOf('/') + 1)}.js`
}

/**
 * The component's jco output, checked to mark every import the WASI 0.2 host
 * answers asynchronously; undefined where none is served. A fallback page
 * served for the missing file is not jco output, so the program stays missing.
 */
async function findComponent (glue: string, command: string, args: readonly string[]): Promise<SpawnProgram | undefined> {
  const response = await fetch(glue).catch(() => undefined)
  // A request that never reached the server says nothing about the app's files, so it is asked again next time.
  if (response === undefined) components.delete(glue)
  if (response?.ok !== true) return undefined
  const text = await response.text()
  if (!isJcoOutput(text)) return undefined
  const unmarked = unmarkedAsyncImports(text)
  if (unmarked.length > 0) {
    throw spawnError('ENOEXEC', command, args, `${command}'s jco output lowers ${unmarked.join(', ')} synchronously, and the host answers them asynchronously: ${transpileCommand(`${new URL(glue).pathname.replace(/\.p2\/[^/]*$/, '')}.wasm`)}`)
  }
  return { kind: 'component', glue, base: new URL('.', glue).href }
}

function loadComponent (glue: string, command: string, args: readonly string[]): Promise<SpawnProgram | undefined> {
  let found = components.get(glue)
  if (found === undefined) {
    found = findComponent(glue, command, args)
    components.set(glue, found)
  }
  return found
}

function isComponent (bytes: Uint8Array): boolean {
  return COMPONENT_VERSION.every((byte, index) => bytes[4 + index] === byte)
}

/** Resolves `command` to a component's jco output or a compiled preview1 program; rejects with a Node-shaped spawn error. */
export async function loadProgram (command: string, args: readonly string[], origin: string = globalThis.location.origin): Promise<SpawnProgram> {
  const urls = programUrls(command, origin)
  if (urls.length === 0) throw spawnError('EACCES', command, args, 'a program must come from the app\'s own origin')
  const component = await loadComponent(componentGlueUrl(urls[0] as string), command, args)
  if (component !== undefined) return component
  const cached = urls.map((url) => compiled.get(url)).find((entry) => entry !== undefined)
  if (cached !== undefined) return { kind: 'core', module: await cached }
  const fetched = await fetchProgram(urls, command, args)
  if (fetched === undefined) throw spawnError('ENOENT', command, args)
  if (isComponent(fetched.bytes)) {
    throw spawnError('ENOEXEC', command, args, `${command} is a WASI 0.2 component, which runs here as jco's output beside it: ${transpileCommand(new URL(fetched.url).pathname)}`)
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
