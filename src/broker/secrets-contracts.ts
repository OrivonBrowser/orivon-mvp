// `orivon.secrets`'s own vocabulary -- pure type declarations, split out of
// ./broker-contracts.ts (code-guidelines.md Rule 2) the same way
// ./web-context-contracts.ts split out of it for ADR-0019, once ADR-0033
// pushed that file toward its 500-line ceiling. Re-exported from
// broker-contracts.ts, so no import site elsewhere needs to change.

/**
 * Backs `orivon.id` -- key derivation from a locked seed (ADR-0010,
 * policy/derive.ts) -- AND, since ADR-0033, `orivon.secrets`
 * (policy/secret-seal.ts). One seed, two derivation paths with distinct
 * salts; see secret-seal.ts's own header for why a shared seed source does
 * not mean a shared construction.
 */
export interface Keychain {
  getSeed(): Promise<Uint8Array>
  /**
   * Whether the seed `getSeed()` returns will still be there next launch.
   * OPTIONAL: every fake `Keychain` in this codebase's tests predates
   * `orivon.secrets` and keeps compiling unchanged, landing on the safe
   * side of the question this answers -- an ABSENT method reads as "never
   * persistent", which is what `secrets-capability.ts`'s `available()`
   * needs when nothing has told it otherwise: sealing a secret behind a
   * seed that will not survive a restart is exactly the silent-data-loss
   * shape `ADR-0033` exists to let an app avoid, so the fail-closed
   * default matters here in a way it would not for a method that only
   * gates a convenience.
   */
  isPersistent?(): Promise<boolean>
}

/**
 * `Broker['secrets']` -- ADR-0033, `orivon.secrets`'s broker-internal
 * counterpart. Origin-addressed like every other capability here, never
 * key-addressed: there is exactly one secret per origin, so there is
 * nothing for a caller to name beyond the origin itself.
 */
export interface BrokerSecretsMethods {
  /** Never rejects. False with no live `secrets` grant, or when the seed is session-only. */
  available(origin: string): Promise<boolean>
  /** Rejects 'denied' with no live `secrets` grant; 'unavailable' when the seed is session-only; 'limit' past `LIMITS.secretBytes`. */
  encrypt(origin: string, plaintext: Uint8Array): Promise<Uint8Array>
  /** Rejects 'denied' with no live `secrets` grant; 'invalid' for bytes this origin's key did not produce. */
  decrypt(origin: string, ciphertext: Uint8Array): Promise<Uint8Array>
}
