// The commit this build was made from, folded in by electron.vite.config.ts. A run of the unit tests has no
// build, so the value is absent there and reads as unknown.
declare const __ORIVON_COMMIT__: string | undefined

export const BUILD_COMMIT: string = typeof __ORIVON_COMMIT__ === 'string' && __ORIVON_COMMIT__ !== '' ? __ORIVON_COMMIT__ : 'unknown'
