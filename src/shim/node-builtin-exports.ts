// Types and access for node-builtin-exports.generated.json: what real Node
// exports, per module-map.ts specifier, as of the Node version named inside
// it. Checked in rather than read live (A287) -- CI's Node is not
// guaranteed to be that version, so every consumer here compares against
// THIS frozen list, never against a fresh `require('node:<specifier>')`.
// Regenerate deliberately (a Node bump, a new module-map.ts row) with
// `ORIVON_WRITE_NODE_BUILTIN_EXPORTS=1 npx vitest run src/shim/tests/node-builtin-exports.test.ts`.

import data from './node-builtin-exports.generated.json'

export interface NodeModuleExports {
  /** Real Node members this module exposes as something CALLABLE: a plain function, or a class (called with `new`). */
  readonly functions: readonly string[]
  /** Real Node members this module exposes as DATA -- an object, string, number, boolean, or (rare) undefined. Never a stand-in target: throwing would misreport the member's own type (A169). */
  readonly data: readonly string[]
}

export interface NodeBuiltinExports {
  readonly nodeVersion: string
  readonly modules: Readonly<Record<string, NodeModuleExports>>
}

export const NODE_BUILTIN_EXPORTS: NodeBuiltinExports = data
