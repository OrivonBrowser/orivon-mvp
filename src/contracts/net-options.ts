// What an app passes to orivon.net.connect and orivon.net.connectSecure. The methods
// live in ./capability-api.ts, which re-exports these two types so that file stays
// within its size limit and no import site changes.

/**
 * `orivon.net.connect`'s argument.
 */
export interface ConnectOptions {
  readonly host: string
  readonly port: number
  /**
   * Abandons the attempt, as destroying a connecting socket does under Node.
   * Aborting it before the call settles stops the dial, frees what it held
   * (the per-origin in-flight slot, a half-open connection the OS had
   * already made) and rejects the call with `'closed'`: the app withdrew
   * the operation, which is what that code says of a handle too. Aborting
   * a signal that is already aborted rejects at once, with no attempt made.
   * Aborting after the call settled does nothing: the app closes the socket
   * it holds, as it would any other. A `signal` that is not an
   * `AbortSignal` rejects with `'invalid'`.
   */
  readonly signal?: AbortSignal
}

/**
 * `orivon.net.connectSecure`'s argument. Every field past `port` is
 * optional and carries Node's own `tls.connect` meaning under Node's own
 * name, except `alpnProtocols` (Node's `ALPNProtocols`). PEM values are
 * strings and binary ones `Uint8Array`, and each is bounded in size: an
 * oversized or malformed option rejects the call with `'invalid'` naming it.
 * Key material serves this one connection only: it is never written to disk
 * and never logged.
 */
export interface SecureConnectOptions {
  readonly host: string
  readonly port: number
  /** Abandons the attempt: `ConnectOptions.signal`'s meaning, the same for both calls. */
  readonly signal?: AbortSignal
  /**
   * Default true. `false` completes the handshake whatever the certificate
   * says, and the connection is then ENCRYPTED BUT UNAUTHENTICATED: anyone
   * on the network path can impersonate the server, read everything and
   * change it. That is the app's own choice, made in its own code (Electrum
   * servers, LND nodes and LAN services commonly present self-signed
   * certificates), and nothing the person granting the app was shown.
   * `SecureTcpSocket.authorized`/`authorizationError` still report what
   * verification found.
   */
  readonly rejectUnauthorized?: boolean
  /**
   * Trust anchors in PEM, one per string or several concatenated. They
   * REPLACE the runtime's built-in roots for this one connection, exactly as
   * Node's `ca` does; an app that wants both passes both.
   */
  readonly ca?: string | readonly string[]
  /** A client certificate chain in PEM, presented when the server asks for one. Paired with `key`; `pfx` is the alternative. */
  readonly cert?: string
  /** The private key for `cert`, in PEM. */
  readonly key?: string
  /** A PKCS#12 bundle holding a client certificate and its key. */
  readonly pfx?: Uint8Array
  /** Decrypts `key` or `pfx`. */
  readonly passphrase?: string
  /**
   * The name sent as SNI and verified against the certificate, when it
   * differs from `host`. Absent, it is `host` when that is a name; `''`
   * sends no SNI and verifies against `host`. Never an address literal.
   * What the connection reaches is decided by `host` alone.
   */
  readonly servername?: string
  /** Protocols offered through ALPN, most preferred first (`['h2', 'http/1.1']`). The one agreed is `SecureTcpSocket.alpnProtocol`. */
  readonly alpnProtocols?: readonly string[]
}

