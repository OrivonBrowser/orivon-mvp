// The host a WASI 0.2 component runs against, as the imports object jco's
// transpiled output takes (keyed by interface, without version), and the
// imports that output must have marked to suspend through JSPI.

import type { WasiFs } from '../wasi/context.js'
import type { SocketNet } from './addresses.js'
import { type CliOptions, cliInterfaces, insecure, insecureSeed, monotonicClock, random, wallClock } from './basics.js'
import { filesystemInterfaces } from './filesystem.js'
import { InputStream, IoError, OutputStream, Pollable, poll } from './io.js'
import { socketInterfaces } from './sockets.js'

export interface ComponentHostOptions extends CliOptions {
  readonly fs: WasiFs
  readonly net: SocketNet
  /** Guest directory name to a path under the virtual root. */
  readonly preopens: Readonly<Record<string, string>>
}

export function componentImports (options: ComponentHostOptions): Record<string, Record<string, unknown>> {
  return {
    ...cliInterfaces(options),
    'wasi:clocks/monotonic-clock': monotonicClock,
    'wasi:clocks/wall-clock': wallClock,
    'wasi:random/random': random,
    'wasi:random/insecure': insecure,
    'wasi:random/insecure-seed': insecureSeed,
    'wasi:io/error': { Error: IoError },
    'wasi:io/poll': { Pollable, poll },
    'wasi:io/streams': { InputStream, OutputStream },
    ...filesystemInterfaces(options.fs, options.preopens),
    ...socketInterfaces(options.net)
  }
}

/**
 * Every import this host answers with a promise, in jco's selector form. A
 * port transpiles with exactly these as `--async-imports`; one left out would
 * receive a promise where it expects a value. A function with no result,
 * such as wasi:cli/exit's, must stay synchronous: jco's glue treats a throw
 * from an asynchronous one as a trap it never reports.
 */
export const ASYNC_IMPORTS: readonly string[] = [
  'wasi:io/poll#poll',
  'wasi:io/poll#[method]pollable.block',
  ...['blocking-read', 'blocking-skip'].map((name) => `wasi:io/streams#[method]input-stream.${name}`),
  ...['blocking-write-and-flush', 'blocking-flush', 'blocking-write-zeroes-and-flush', 'blocking-splice'].map((name) => `wasi:io/streams#[method]output-stream.${name}`),
  ...[
    'sync-data', 'sync', 'set-size', 'read', 'write', 'read-directory', 'create-directory-at', 'stat', 'stat-at',
    'readlink-at', 'open-at', 'remove-directory-at', 'rename-at', 'unlink-file-at', 'metadata-hash', 'metadata-hash-at'
  ].map((name) => `wasi:filesystem/types#[method]descriptor.${name}`)
]

/** The one export a command component is entered through; it must be asynchronous so the imports above can suspend. */
export const ASYNC_EXPORTS: readonly string[] = ['wasi:cli/run#run']
