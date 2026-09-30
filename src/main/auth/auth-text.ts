// What the sign-in sheet says. It is built here, from what Electron reports about the asking server, so the
// page only draws strings and nothing a web page wrote reaches it except the realm, which is cleaned first.
import type { AuthServer } from './auth-queue.js'

/** A longer realm is page-authored text the sheet would only be lending its authority to. */
export const MAX_REALM = 80

export interface AuthView {
  readonly id: string
  readonly title: string
  /** `scheme://host:port` of the server that asked, or `host:port` of a proxy. */
  readonly origin: string
  readonly line: string
  readonly realm: string | null
  /** Set when the request comes from a part of the page, not the page itself. */
  readonly mismatch: string | null
  readonly insecure: string | null
  /** The server asked again after a wrong answer. */
  readonly retry: boolean
  readonly username: string
  /** The username of a saved password the sheet may fill from, never the password. */
  readonly saved: string | null
  /** Whether the sheet offers "Remember this password". */
  readonly canRemember: boolean
}

const DEFAULT_PORTS: Readonly<Record<string, number>> = { http: 80, https: 443 }

/** A control character, or a character that reorders the text around it, turns into a space. */
const NOT_DRAWN = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g

const hostPart = (host: string): string => host.includes(':') && !host.startsWith('[') ? `[${host}]` : host

/** `host` or `host:port`, the port left out when it is the scheme's own. */
export function hostAndPort (server: Pick<AuthServer, 'host' | 'port' | 'scheme'>): string {
  return server.port === DEFAULT_PORTS[server.scheme] ? hostPart(server.host) : `${hostPart(server.host)}:${String(server.port)}`
}

export function originOf (server: AuthServer): string {
  return server.isProxy ? `${hostPart(server.host)}:${String(server.port)}` : `${server.scheme}://${hostAndPort(server)}`
}

/** The realm as one plain line, or null when there is none or it is too long to be a name. */
export function realmText (realm: string): string | null {
  const plain = realm.replace(NOT_DRAWN, ' ').trim()
  return plain === '' || plain.length > MAX_REALM ? null : plain
}

export function titleOf (server: Pick<AuthServer, 'isProxy'>): string {
  return server.isProxy ? 'Sign in to the proxy' : 'Sign in'
}

export function lineOf (server: AuthServer): string {
  return server.isProxy ? `The proxy ${hostPart(server.host)}:${String(server.port)} needs a username and password.` : 'This site is asking for a username and password.'
}

export const INSECURE_TEXT = 'Your password will be sent without encryption.'

export function mismatchText (server: AuthServer): string {
  return `This request comes from ${hostAndPort(server)}, not from the page you are on.`
}
