// What `gsettings list-recursively org.gnome.system.proxy` printed on a GNOME computer, as the program prints it: the keys come in this order, and every server section is there whether or not it is used.

interface Server {
  readonly host?: string
  readonly port?: number
}

export interface GsettingsFixture {
  readonly mode?: string
  readonly ignore?: string
  readonly same?: boolean
  readonly url?: string
  readonly http?: Server
  readonly https?: Server
  readonly socks?: Server
  /** Printed as the password of the sign-in the HTTP proxy would take. */
  readonly password?: string
}

const quoted = (text: string): string => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`

export function gsettingsOutput (fixture: GsettingsFixture = {}): string {
  const server = (name: string, one: Server | undefined, defaultPort: number): string[] => [
    `org.gnome.system.proxy.${name} host ${quoted(one?.host ?? '')}`,
    `org.gnome.system.proxy.${name} port ${String(one?.port ?? defaultPort)}`
  ]
  return [
    `org.gnome.system.proxy autoconfig-url ${quoted(fixture.url ?? '')}`,
    `org.gnome.system.proxy ignore-hosts ${fixture.ignore ?? "['localhost', '127.0.0.0/8', '::1']"}`,
    `org.gnome.system.proxy mode ${quoted(fixture.mode ?? 'none')}`,
    `org.gnome.system.proxy use-same-proxy ${String(fixture.same ?? true)}`,
    ...server('ftp', undefined, 0),
    `org.gnome.system.proxy.http authentication-password ${quoted(fixture.password ?? '')}`,
    "org.gnome.system.proxy.http authentication-user ''",
    'org.gnome.system.proxy.http enabled false',
    ...server('http', fixture.http, 8080),
    'org.gnome.system.proxy.http use-authentication false',
    ...server('https', fixture.https, 0),
    ...server('socks', fixture.socks, 0)
  ].join('\n') + '\n'
}
