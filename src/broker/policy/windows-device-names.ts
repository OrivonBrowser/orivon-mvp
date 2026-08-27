// The Windows reserved-device-name alternation, shared between paths.ts and
// canonical-path.ts (docs/development/code-guidelines.md Rule 3) -- the table
// only, not the two wrapper checks, which apply it differently: paths.ts
// uppercases its input first and tests case-sensitively; canonical-path.ts
// tests the raw segment case-insensitively. Exported as the pattern SOURCE,
// not a compiled RegExp, so each caller builds its own with its own flags --
// a shared RegExp instance is stateful when used with the `g` flag and a trap
// waiting for whichever of these two gains one first.

/**
 * `CON.txt` is the device with any extension; `CONFIG` is not -- both callers
 * test only the component up to its first dot. Rejected on every platform,
 * not only Windows: a torrent that writes `CON.txt` should fail identically
 * everywhere rather than work on Linux and hang a Windows user's download.
 */
export const WINDOWS_DEVICE_NAME_PATTERN = '^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$'
