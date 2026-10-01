// Orivon patch (UPSTREAM.md patch 45): the main-world functions the host
// wants injected after the library's own namespaces. Orivon's preload sets
// the list before preload.ts reads it; the library itself never sets one.
let extras: ReadonlyArray<() => void> = []

export function setExtraMainWorldApis(list: ReadonlyArray<() => void>): void {
  extras = list
}

export function getExtraMainWorldApis(): ReadonlyArray<() => void> {
  return extras
}
