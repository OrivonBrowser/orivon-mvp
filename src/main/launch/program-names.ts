// The names the two Orivon programs on one computer go by: each names its data directory, its window class and
// its Linux desktop entry (ADR-0057).

/** An installed package's name: package.json's `name`, which Electron takes as the app name. */
export const PACKAGE_PROGRAM = 'orivon'

/** A run from source's name, which it takes before it reads any data (`takeSourceIdentity` in `start-launch.ts`). */
export const SOURCE_PROGRAM = 'orivon-source'
