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

This repository's code is TypeScript only. No Rust, no C++, no native addons. Apps Orivon runs
are not bound by this: WebAssembly built from any language qualifies (ADR-0036). `orivon-runtime`
(Wasmtime) is deferred, not cancelled, and is post-MVP. If this is really needed, it is an ADR,
not a file.
