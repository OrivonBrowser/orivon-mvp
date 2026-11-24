---
name: block-non-typescript-sources
enabled: true
event: file
action: block
conditions:
  - field: file_path
    operator: regex_match
    pattern: \.(rs|c|cc|cpp|cxx|h|hpp|go|swift|m|mm)$|Cargo\.toml$|CMakeLists\.txt$|binding\.gyp$
---

**Non-TypeScript source file — blocked (ADR-0002).**

This repository's code stays TypeScript. Where another language would be exceptionally beneficial,
propose it to the owner first; no native addons either way (`CLAUDE.md` Rule 8). Apps Orivon runs
are not bound by this: WebAssembly built from any language qualifies (ADR-0036). A WASM runtime
is a possible option, not a plan. If this is really needed, it is an ADR,
not a file.
