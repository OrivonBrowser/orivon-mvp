// The public keys a release's file list may be signed with, as SPKI PEM. Several so one can be rotated in before
// the other is retired. The private half is the maintainer's and is held offline, never in a repository.
export const TRUSTED_UPDATE_KEYS: readonly string[] = [
  `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAWx+BOqDTGQR/bpT7mjXUdrnjHZARIPgCgb164GXISl0=
-----END PUBLIC KEY-----
`
]
