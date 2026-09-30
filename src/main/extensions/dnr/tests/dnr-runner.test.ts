import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import {
  loadStaticRulesets,
  parseRuleResources,
  readDynamicRules,
  readEnabledRulesetOverride,
  writeDynamicRules,
  writeEnabledRulesetOverride,
} from '../dnr-runner.js'

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-dnr-runner-test-'))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('parseRuleResources', () => {
  it('extracts valid entries from a declarative_net_request manifest value', () => {
    const resources = parseRuleResources({
      rule_resources: [{ id: 'a', enabled: true, path: 'a.json' }, { id: 'b', enabled: false, path: 'b.json' }],
    })
    expect(resources).toEqual([
      { id: 'a', enabled: true, path: 'a.json' },
      { id: 'b', enabled: false, path: 'b.json' },
    ])
  })

  it('drops a malformed entry without throwing', () => {
    const resources = parseRuleResources({
      rule_resources: [{ id: 'ok', enabled: true, path: 'ok.json' }, { id: 123, enabled: true, path: 'bad.json' }, 'garbage', null],
    })
    expect(resources).toEqual([{ id: 'ok', enabled: true, path: 'ok.json' }])
  })

  it('returns [] for anything not shaped like the manifest value', () => {
    expect(parseRuleResources(undefined)).toEqual([])
    expect(parseRuleResources(null)).toEqual([])
    expect(parseRuleResources('not an object')).toEqual([])
    expect(parseRuleResources({})).toEqual([])
    expect(parseRuleResources({ rule_resources: 'not an array' })).toEqual([])
  })
})

describe('loadStaticRulesets', () => {
  it('reads each resource\'s rules from the extension\'s loaded folder', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'a.json'), JSON.stringify([{ id: 1, priority: 1, condition: {}, action: { type: 'block' } }]))
      const rulesets = loadStaticRulesets(dir, [{ id: 'a', enabled: true, path: 'a.json' }], null)
      expect(rulesets).toEqual([
        { id: 'a', enabled: true, rules: [{ id: 1, priority: 1, condition: {}, action: { type: 'block' } }] },
      ])
    })
  })

  it('a leading slash in a resource path is extension-root-relative, not filesystem-absolute (Chrome\'s own convention, e.g. uBOL\'s "/rulesets/main/x.json")', () => {
    withTempDir((dir) => {
      mkdirSync(join(dir, 'rulesets', 'main'), { recursive: true })
      writeFileSync(
        join(dir, 'rulesets', 'main', 'x.json'),
        JSON.stringify([{ id: 1, priority: 1, condition: { urlFilter: 'x' }, action: { type: 'block' } }])
      )
      const rulesets = loadStaticRulesets(dir, [{ id: 'a', enabled: true, path: '/rulesets/main/x.json' }], null)
      expect(rulesets).toEqual([
        { id: 'a', enabled: true, rules: [{ id: 1, priority: 1, condition: { urlFilter: 'x' }, action: { type: 'block' } }] },
      ])
    })
  })

  it('refuses a resource path that escapes the extension folder, logging and yielding no rules', () => {
    withTempDir((dir) => {
      const outsideDir = mkdtempSync(join(tmpdir(), 'orivon-dnr-runner-outside-'))
      try {
        const secretPath = join(outsideDir, 'secret.json')
        writeFileSync(secretPath, JSON.stringify([{ id: 1, priority: 1, condition: {}, action: { type: 'block' } }]))
        const escaped = relative(dir, secretPath)
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        const rulesets = loadStaticRulesets(dir, [{ id: 'a', enabled: true, path: escaped }], null)
        expect(rulesets).toEqual([{ id: 'a', enabled: true, rules: [] }])
        expect(error).toHaveBeenCalled()
        error.mockRestore()
      } finally {
        rmSync(outsideDir, { recursive: true, force: true })
      }
    })
  })

  it('skips a missing ruleset file with an empty rule list, logging a reason', () => {
    withTempDir((dir) => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const rulesets = loadStaticRulesets(dir, [{ id: 'a', enabled: true, path: 'missing.json' }], null)
      expect(rulesets).toEqual([{ id: 'a', enabled: true, rules: [] }])
      expect(error).toHaveBeenCalled()
      error.mockRestore()
    })
  })

  it('skips a ruleset file that is not valid JSON, without throwing', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'a.json'), '{ not json')
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const rulesets = loadStaticRulesets(dir, [{ id: 'a', enabled: true, path: 'a.json' }], null)
      expect(rulesets).toEqual([{ id: 'a', enabled: true, rules: [] }])
      error.mockRestore()
    })
  })

  it('an enabledOverride replaces each resource\'s own manifest-default enabled flag', () => {
    withTempDir((dir) => {
      writeFileSync(join(dir, 'a.json'), '[]')
      writeFileSync(join(dir, 'b.json'), '[]')
      const rulesets = loadStaticRulesets(
        dir,
        [
          { id: 'a', enabled: true, path: 'a.json' },
          { id: 'b', enabled: false, path: 'b.json' },
        ],
        ['b']
      )
      expect(rulesets.map((r) => [r.id, r.enabled])).toEqual([
        ['a', false],
        ['b', true],
      ])
    })
  })
})

describe('dynamic rules persistence', () => {
  it('round-trips through readDynamicRules/writeDynamicRules', () => {
    withTempDir((dir) => {
      expect(readDynamicRules(dir)).toEqual([])
      const rules = [{ id: 1, priority: 1, condition: { urlFilter: 'x' }, action: { type: 'block' as const } }]
      writeDynamicRules(dir, rules)
      expect(readDynamicRules(dir)).toEqual(rules)
    })
  })

  it('readDynamicRules recovers to [] from a corrupt file instead of throwing', () => {
    withTempDir((dir) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'dnr-dynamic.json'), '{ not json')
      expect(readDynamicRules(dir)).toEqual([])
    })
  })
})

describe('enabled-ruleset override persistence', () => {
  it('is null until the extension has ever called updateEnabledRulesets', () => {
    withTempDir((dir) => {
      expect(readEnabledRulesetOverride(dir)).toBeNull()
    })
  })

  it('round-trips through readEnabledRulesetOverride/writeEnabledRulesetOverride', () => {
    withTempDir((dir) => {
      writeEnabledRulesetOverride(dir, ['a', 'c'])
      expect(readEnabledRulesetOverride(dir)).toEqual(['a', 'c'])
    })
  })

  it('recovers to null from a corrupt file instead of throwing', () => {
    withTempDir((dir) => {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'dnr-enabled-rulesets.json'), '{ not json')
      expect(readEnabledRulesetOverride(dir)).toBeNull()
    })
  })
})
