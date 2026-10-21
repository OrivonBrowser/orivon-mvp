// What survives a restart of an app the person allowed and whose files are not yet all pinned (ADR-0075): the
// manifest they were asked about, the root it was read from and the tree the site declared then. With it the app is
// served again, every file checked, and its pin resumed for that very root, never the old install path, and a name or
// site that has moved since is an update the person is asked about. Read back off disk as untrusted input.

import type { Manifest } from '../contracts/index.js'
import { parseContentAddress } from '../broker/policy/pin.js'
import type { ContentAddress } from '../broker/policy/pin.js'
import { originFromUrl } from '../broker/policy/origin.js'
import { isString, ownProperty } from '../broker/policy/own-property.js'
import { ddocToJson, parseDdocDeclaration } from './ddoc-declaration.js'
import type { DdocDeclaration } from './ddoc-declaration.js'
import type { FirstManifestApp } from './first-visit.js'
import { parseManifest } from './manifest/manifest.js'

export interface PendingConsent {
  readonly read: FirstManifestApp
  readonly declaration: DdocDeclaration | undefined
}

export function pendingRecord (read: FirstManifestApp, declaration: DdocDeclaration | undefined, consentedAt: number): object {
  return {
    schema: 1,
    origin: read.canonicalOrigin,
    manifestBytes: Buffer.from(read.bytes).toString('base64'),
    ...(read.content === undefined ? {} : { content: read.content }),
    ...(declaration === undefined ? {} : { declaration: ddocToJson(declaration) }),
    consentedAt
  }
}

/** `undefined` for anything that is not a record this version wrote: a consent that cannot be read is no consent. */
export function parsePending (raw: unknown): PendingConsent | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const origin = ownProperty(raw, 'origin', isString)
  const encoded = ownProperty(raw, 'manifestBytes', isString)
  if (origin === undefined || encoded === undefined || originFromUrl(origin) !== origin) return undefined
  const bytes = new Uint8Array(Buffer.from(encoded, 'base64'))
  const parsed = parseManifest(new TextDecoder('utf-8', { fatal: false }).decode(bytes))
  if (!parsed.ok) return undefined
  let content: ContentAddress | undefined
  if (Object.hasOwn(raw, 'content')) {
    const found = parseContentAddress((raw as { content?: unknown }).content)
    if (found === null) return undefined
    content = found
  }
  let declaration: DdocDeclaration | undefined
  if (Object.hasOwn(raw, 'declaration')) {
    declaration = parseDdocDeclaration((raw as { declaration?: unknown }).declaration)
    if (declaration === undefined) return undefined
  }
  const manifest: Manifest = parsed.manifest
  return { read: { kind: 'app', canonicalOrigin: origin, manifest, bytes, content }, declaration }
}
