import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { checkNoSecrets } from './check-no-secrets.mjs'

/** A git repo whose tracked files are exactly those given. */
const repo = (files: Record<string, string>): string => {
  const root = mkdtempSync(join(tmpdir(), 'orivon-secrets-'))
  execFileSync('git', ['init', '-q'], { cwd: root })
  for (const [name, body] of Object.entries(files)) {
    const full = join(root, name)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  execFileSync('git', ['add', '-A'], { cwd: root })
  return root
}

describe('checkNoSecrets', () => {
  describe('what it must catch', () => {
    it.each([
      ['a telegram bot token', 'const t = "1234567890:AAFAKEfakeFAKEfakeFAKEfakeFAKEfake0"\n', 'telegram-bot-token'],
      ['a github classic PAT', 'TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n', 'github-token'],
      ['a github oauth token', 'TOKEN=gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n', 'github-token'],
      ['an aws access key', 'aws_access_key_id = AKIAIOSFODNN7EXAMPLE\n', 'aws-access-key'],
      ['a private key header', '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n', 'private-key'],
      ['a slack token', 'xoxb-EXAMPLE-NOT-A-REAL-TOKEN-000000000000\n', 'slack-token']
    ])('catches %s', (_label, body, kind) => {
      const result = checkNoSecrets(repo({ 'config.js': body }))
      expect(result.ok).toBe(false)
      expect(result.findings).toHaveLength(1)
      expect(result.findings[0]?.kind).toBe(kind)
      expect(result.findings[0]?.file).toBe('config.js')
    })

    it('reports the line number', () => {
      const body = 'line one\nline two\nTOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n'
      expect(checkNoSecrets(repo({ 'a.js': body })).findings[0]?.line).toBe(3)
    })

    it('finds secrets in more than one file', () => {
      const root = repo({
        'a.js': 'x = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"\n',
        'b.js': 'y = "AKIAIOSFODNN7EXAMPLE"\n'
      })
      expect(checkNoSecrets(root).findings).toHaveLength(2)
    })

    // The guard's own output goes to CI logs, which are public on a public repo.
    // A guard that prints the secret it found has published it a second time.
    it('NEVER includes the matched value in a finding', () => {
      const secret = '1234567890:AAFAKEfakeFAKEfakeFAKEfakeFAKEfake0'
      const result = checkNoSecrets(repo({ 'a.js': `t = "${secret}"\n` }))
      expect(JSON.stringify(result)).not.toContain(secret)
      expect(JSON.stringify(result)).not.toContain('AAFAKEfake')
    })
  })

  // Closes the hole that let a real token into this very file during
  // development: the guard exempts its own test (which must contain
  // token-shaped strings), so pattern matching alone can never see itself.
  // This check does not rely on patterns at all -- it looks for the literal
  // values of the credentials actually configured on this machine, in EVERY
  // tracked file including the exempt ones.
  describe('live-credential check', () => {
    it('catches a configured credential even inside an exempt file', () => {
      const root = repo({
        'scripts/check-no-secrets.test.ts': 'const sample = "s3cr3t-live-value-abcdef"\n'
      })
      const result = checkNoSecrets(root, { knownSecrets: ['s3cr3t-live-value-abcdef'] })
      expect(result.ok).toBe(false)
      expect(result.findings[0]?.kind).toBe('live-credential')
    })

    it('still never prints the value', () => {
      const root = repo({ 'a.js': 'x = "s3cr3t-live-value-abcdef"\n' })
      const result = checkNoSecrets(root, { knownSecrets: ['s3cr3t-live-value-abcdef'] })
      expect(JSON.stringify(result)).not.toContain('s3cr3t-live-value')
    })

    it('ignores short or placeholder-looking values', () => {
      const root = repo({ 'a.js': 'mode = "telegram"\nx = "none"\n' })
      const result = checkNoSecrets(root, { knownSecrets: ['telegram', 'none', 'x'] })
      expect(result.ok).toBe(true)
    })

    it('is a no-op when nothing is configured', () => {
      const root = repo({ 'a.js': 'fine\n' })
      expect(checkNoSecrets(root, { knownSecrets: [] })).toEqual({ ok: true, findings: [] })
    })
  })

  describe('what it must not flag', () => {
    it('allows a placeholder in an example file', () => {
      const root = repo({
        '.env.example': 'TELEGRAM_BOT_TOKEN=<your-bot-token>\nGITHUB_TOKEN=ghp_xxx\n'
      })
      expect(checkNoSecrets(root).ok).toBe(true)
    })

    it('allows prose describing a token shape', () => {
      const root = repo({
        'docs/security.md': 'Tokens look like ghp_ followed by 36 characters. Never commit one.\n'
      })
      expect(checkNoSecrets(root).ok).toBe(true)
    })

    it('does not flag its own source', () => {
      const root = repo({ 'scripts/check-no-secrets.mjs': 'const GITHUB = /ghp_[A-Za-z0-9]{36}/\n' })
      expect(checkNoSecrets(root).ok).toBe(true)
    })

    it('ignores untracked files', () => {
      const root = repo({ 'tracked.js': 'fine\n' })
      writeFileSync(join(root, 'untracked.js'), 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n')
      expect(checkNoSecrets(root).ok).toBe(true)
    })

    it('ignores a short hex string that merely looks tokenish', () => {
      const root = repo({ 'a.js': 'const sha = "d4794c5"\nconst id = "12345678"\n' })
      expect(checkNoSecrets(root).ok).toBe(true)
    })

    it('passes on an empty repo', () => {
      expect(checkNoSecrets(repo({}))).toEqual({ ok: true, findings: [] })
    })

    // A real PNG carries NUL bytes in the IHDR length field, which is the
    // standard "this is binary" heuristic.
    it('skips a file containing NUL bytes', () => {
      const png = '\x89PNG\r\n\x1a\n\x00\x00\x00\x0DIHDR ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
      expect(checkNoSecrets(repo({ 'img.png': png })).ok).toBe(true)
    })

    it('skips known binary extensions even without an early NUL', () => {
      const root = repo({ 'icon.ico': 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789' })
      expect(checkNoSecrets(root).ok).toBe(true)
    })

    it('still scans a text file with an unusual extension', () => {
      const root = repo({ 'deploy.conf': 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n' })
      expect(checkNoSecrets(root).ok).toBe(false)
    })
  })
})
