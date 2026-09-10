// Moved to src/broker/policy/manifest-patterns.ts (2026-09-10, P4-1):
// src/broker/policy/request-grant.ts needs the exact same Manifest.capabilities
// -> PatternSet conversion decideUpdate() already used here, and src/broker/
// may never import src/loader/ (src/broker/README.md) -- only the reverse.
// Re-exported under this file's original path so src/loader/index.ts's
// existing import needs no change.
export { patternSetFromCapabilities } from '../broker/policy/manifest-patterns.js'
