// Which files run code when opened. Orivon never opens one of these for the person: the Downloads page
// shows "Open it from the folder" and leaves the decision to the operating system's own file manager.
// Pure: no Electron, no Node.

const DANGEROUS_EXTENSIONS: ReadonlySet<string> = new Set([
  // Programs and installers.
  'exe', 'msi', 'msp', 'mst', 'msix', 'msixbundle', 'appx', 'appxbundle', 'com', 'scr', 'pif', 'dll', 'jar', 'jnlp',
  'run', 'appimage', 'deb', 'rpm', 'dmg', 'pkg', 'mpkg', 'app', 'apk', 'gadget', 'application', 'xbap',
  // Scripts, which a double click hands to an interpreter.
  'bat', 'cmd', 'ps1', 'psm1', 'psd1', 'ps1xml', 'psc1', 'vbs', 'vbe', 'vb', 'js', 'jse', 'wsf', 'wsh', 'ws', 'wsc',
  'sh', 'bash', 'command', 'py', 'pyw', 'pl', 'rb', 'scpt', 'applescript', 'workflow', 'terminal',
  // Windows files that run something when opened: control panel and management consoles, help files, shortcuts and
  // links, setup information, registry changes.
  'cpl', 'msc', 'chm', 'scf', 'lnk', 'url', 'website', 'inf', 'reg', 'hta', 'appref-ms', 'settingcontent-ms',
  'desktop', 'webloc', 'inetloc', 'fileloc',
  // Disc and disk images, which the operating system mounts and so skips the mark that says a file came from the web.
  'iso', 'img', 'vhd', 'vhdx'
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
