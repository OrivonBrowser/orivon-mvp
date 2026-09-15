// fs.readFile / writeFile / mkdir / readdir / stat / rm / rename, split out
// of ./ipc.ts's dispatch() switch under code-guidelines.md Rule 2 -- see
// ./dispatch-app.ts's header for the seam this and its siblings share.

import { fail } from '../errors.js'
import type { Broker } from '../broker-contracts.js'
import {
  isFsPathWithRecursiveParams, isFsReaddirParams, isFsReadFileParams,
  isFsRenameParams, isFsStatParams, isFsWriteFileParams
} from './ipc-validation.js'
import type { ControlMethod } from './ipc-validation.js'

/** The `fs.*` slice of `ControlMethod` -- see ./dispatch-app.ts's own `AppControlMethod` for why this is derived rather than retyped. */
export type FsControlMethod = Extract<ControlMethod, `fs.${string}`>

/** `fs.*`'s dispatch cases, unchanged from ./ipc.ts's own switch. */
export async function dispatchFs (
  broker: Broker,
  origin: string,
  method: FsControlMethod,
  payload: unknown
): Promise<unknown> {
  switch (method) {
    case 'fs.readFile': {
      if (!isFsReadFileParams(payload)) throw fail('invalid', 'fs.readFile requires { path: string }')
      return await broker.fs.readFile(origin, payload.path)
    }
    case 'fs.writeFile': {
      if (!isFsWriteFileParams(payload)) throw fail('invalid', 'fs.writeFile requires { path: string, data: Uint8Array }')
      await broker.fs.writeFile(origin, payload.path, payload.data)
      return undefined
    }
    case 'fs.mkdir': {
      if (!isFsPathWithRecursiveParams(payload)) throw fail('invalid', 'fs.mkdir requires { path: string, recursive?: boolean }')
      await broker.fs.mkdir(origin, payload.path, payload.recursive === undefined ? undefined : { recursive: payload.recursive })
      return undefined
    }
    case 'fs.readdir': {
      if (!isFsReaddirParams(payload)) throw fail('invalid', 'fs.readdir requires { path: string }')
      return await broker.fs.readdir(origin, payload.path)
    }
    case 'fs.stat': {
      if (!isFsStatParams(payload)) throw fail('invalid', 'fs.stat requires { path: string }')
      return await broker.fs.stat(origin, payload.path)
    }
    case 'fs.rm': {
      if (!isFsPathWithRecursiveParams(payload)) throw fail('invalid', 'fs.rm requires { path: string, recursive?: boolean }')
      await broker.fs.rm(origin, payload.path, payload.recursive === undefined ? undefined : { recursive: payload.recursive })
      return undefined
    }
    case 'fs.rename': {
      if (!isFsRenameParams(payload)) throw fail('invalid', 'fs.rename requires { from: string, to: string }')
      await broker.fs.rename(origin, payload.from, payload.to)
      return undefined
    }
  }
}
