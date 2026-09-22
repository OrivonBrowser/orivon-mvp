// A capability the person already answered for -- declined at install, or
// revoked since -- must not be asked about again on every visit. The
// pinned manifest's declared set is what they were asked about.

import { describe, expect, it } from 'vitest'
import { decideUpdate } from '../update.js'
import type { UpdateInput } from '../update.js'

const HASH = 'sha256:' + 'a'.repeat(64)
const OTHER_HASH = 'sha256:' + 'b'.repeat(64)

function input (overrides: Partial<UpdateInput>): UpdateInput {
  return {
    pinnedHash: HASH,
    newHash: HASH,
    grantedPatterns: {},
    newPatterns: { 'tcp.connect': ['api.example.com:443'], fs: [] },
    version: '1.0.0',
    versionFloor: '1.0.0',
    rollbackAcknowledged: false,
    ...overrides
  }
}

describe('decideUpdate: previouslyDeclaredPatterns', () => {
  it('without it, a declined capability re-prompts on every unchanged visit (the behaviour it exists to stop)', () => {
    expect(decideUpdate(input({ grantedPatterns: { fs: [] } }))).toBe('capability-prompt')
  })

  it('an unchanged bundle whose declined capability was already declared installs silently, granting nothing new', () => {
    const declared = { 'tcp.connect': ['api.example.com:443'], fs: [] }
    expect(decideUpdate(input({ grantedPatterns: { fs: [] }, previouslyDeclaredPatterns: declared }))).toBe('silent')
  })

  it('a changed bundle with the same declared authority is a reconsent, not a capability prompt', () => {
    const declared = { 'tcp.connect': ['api.example.com:443'], fs: [] }
    expect(decideUpdate(input({ newHash: OTHER_HASH, previouslyDeclaredPatterns: declared }))).toBe('reconsent')
  })

  it('anything outside both the granted and the previously declared set still prompts', () => {
    const declared = { 'tcp.connect': ['api.example.com:443'] }
    expect(decideUpdate(input({ previouslyDeclaredPatterns: declared, newPatterns: { 'tcp.connect': ['*:*'] } }))).toBe('capability-prompt')
    expect(decideUpdate(input({ previouslyDeclaredPatterns: declared, newPatterns: { 'tcp.connect': ['api.example.com:443'], 'udp.send': ['*:*'] } }))).toBe('capability-prompt')
  })
})
