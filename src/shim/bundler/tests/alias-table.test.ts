// alias-table.generated.json is what the bundler plugin reads, so that it
// loads without this repository's TypeScript. It is derived from
// module-map.ts; this fails when the checked-in copy is stale. Run with
// ORIVON_WRITE_ALIAS_TABLE=1 to rewrite it after editing a module-map.ts row.

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { buildAliasEntries } from '../../module-map.js'
import { VIRTUAL_ROOT } from '../../virtual-root.js'

const GENERATED = fileURLToPath(new URL('../alias-table.generated.json', import.meta.url))

it('alias-table.generated.json is the current module-map.ts alias table', () => {
  const fresh = `${JSON.stringify({ virtualRoot: VIRTUAL_ROOT, entries: buildAliasEntries() }, null, 2)}\n`
  if (process.env.ORIVON_WRITE_ALIAS_TABLE === '1') writeFileSync(GENERATED, fresh)
  expect(readFileSync(GENERATED, 'utf8'), 'stale: rerun with ORIVON_WRITE_ALIAS_TABLE=1').toBe(fresh)
})
