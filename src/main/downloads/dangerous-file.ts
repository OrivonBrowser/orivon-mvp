// Which files run code when opened. Orivon never opens one of these for the person: the Downloads page
// shows "Open it from the folder" and leaves the decision to the operating system's own file manager.
// Pure: no Electron, no Node.

const DANGEROUS_EXTENSIONS: ReadonlySet<string> = new Set([
  'exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'pif', 'ps1', 'vbs', 'js', 'jse', 'wsf', 'hta', 'lnk', 'reg', 'dll',
  'jar', 'sh', 'run', 'appimage', 'deb', 'rpm', 'dmg', 'pkg', 'app', 'command', 'desktop', 'apk'
])

const EXECUTABLE_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-dosexec',
  'application/vnd.microsoft.portable-executable',
  'application/x-executable',
  'application/x-mach-binary',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-csh',
  'application/x-msi',
  'application/x-ms-installer',
  'application/hta',
  'application/java-archive',
  'application/x-apple-diskimage',
  'application/vnd.android.package-archive',
  'application/x-debian-package',
  'application/x-rpm',
  'application/x-redhat-package-manager'
])

/** `photo.jpg.exe` is dangerous: only the last extension counts, in any case. A type the name does not give away
 * (a server calling an installer `download.bin`) is caught by its content type. */
export function isDangerousFile (name: string, mime: string): boolean {
  const dot = name.trim().lastIndexOf('.')
  if (dot !== -1 && DANGEROUS_EXTENSIONS.has(name.trim().slice(dot + 1).toLowerCase())) return true
  return EXECUTABLE_MIME_TYPES.has(mime.split(';')[0]?.trim().toLowerCase() ?? '')
}
