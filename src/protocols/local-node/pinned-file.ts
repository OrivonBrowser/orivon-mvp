// Reads one file the build pins, once, and hands back exactly the bytes that were hashed. A local node's component
// (component.ts) and the Nym tunnel's module (../nym-tunnel/) both run only bytes read here.

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PinnedFile } from './protocol.js'

/** A file whose bytes are not the ones the build pins, or that the build does not pin at all. */
export class PinMismatch extends Error {}

const PINNED_NAME = /^[\w.-]+$/

/** The pinned file `file`, read once, with the bytes that were hashed: a name that is not pinned, or bytes that differ from the pin, are refused. */
export async function readPinned (directory: string, pins: readonly PinnedFile[], file: string): Promise<Buffer> {
  const pin = PINNED_NAME.test(file) ? pins.find((entry) => entry.name === file) : undefined
  if (pin === undefined) throw new PinMismatch(`the component asks for ${JSON.stringify(file)}, which this build does not pin`)
  const bytes = await readFile(join(directory, file))
  if (bytes.length !== pin.bytes || createHash('sha256').update(bytes).digest('hex') !== pin.sha256) throw new PinMismatch(`${file} is not the file this build pins`)
  return bytes
}
