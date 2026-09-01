// Shared fixtures for connect.test.ts and connect-patterns.test.ts (split out
// of one file that exceeded docs/development/code-guidelines.md's 800-line
// test limit). Not *.test.ts, so vitest does not collect it as its own suite.
//
// manifestOf/manifestWith lived here until A18 (docs/open-questions.md):
// checkConnect took a whole Manifest and both helpers existed only to build
// one around a single `net.tcp.connect` array. Now that checkConnect takes
// that array directly (readonly Pattern[], the GRANTED patterns, not the
// manifest's declared ones), a pattern list is just a plain array literal at
// the call site and the wrapper added nothing.

import type { ConnectDecision, Resolver } from './connect.js'

export interface StubResolver {
  (host: string): Promise<readonly string[]>
  readonly calls: string[]
}

/** Records what it was asked, so "resolve ONCE" is assertable and not assumed. */
export function resolverFor (answers: Readonly<Record<string, readonly string[]>>): StubResolver {
  const calls: string[] = []
  const fn = async (host: string): Promise<readonly string[]> => {
    calls.push(host)
    return answers[host] ?? []
  }
  return Object.assign(fn, { calls })
}

export const noResolution: Resolver = async () => {
  throw new Error('the resolver must not be called for an address literal')
}

export function allowedAddresses (decision: ConnectDecision): readonly string[] {
  if (!decision.allowed) throw new Error('expected an allow, got a denial')
  return decision.addresses
}

export const PUBLIC_A = '93.184.216.34'
export const PUBLIC_B = '8.8.8.8'
export const PUBLIC_V6 = '2606:4700::1111'
