// The folder tree as a flat list in tree order: which folders show, what is inside one, and what is above it. Pure.

export interface FolderInfo {
  readonly id: string
  readonly title: string
  readonly depth: number
  /** Folders directly inside. */
  readonly folders: number
  /** Everything directly inside. */
  readonly items: number
}

/** The folders of the tree that show: each one's ancestors are open. */
export function visibleFolders (folders: readonly FolderInfo[], expanded: ReadonlySet<string>): FolderInfo[] {
  const out: FolderInfo[] = []
  let hiddenBelow = Infinity
  for (const folder of folders) {
    if (folder.depth > hiddenBelow) continue
    hiddenBelow = Infinity
    out.push(folder)
    if (!expanded.has(folder.id)) hiddenBelow = folder.depth
  }
  return out
}

/** The folder `id` and every folder inside it, in the tree's own order. */
export function folderBranch (folders: readonly FolderInfo[], id: string): Set<string> {
  const at = folders.findIndex((folder) => folder.id === id)
  const out = new Set<string>()
  const top = folders[at]
  if (top === undefined) return out
  out.add(top.id)
  for (const folder of folders.slice(at + 1)) {
    if (folder.depth <= top.depth) break
    out.add(folder.id)
  }
  return out
}

/** The folder above `id` in the tree, or null at a root. */
export function parentFolder (folders: readonly FolderInfo[], id: string): FolderInfo | null {
  const at = folders.findIndex((folder) => folder.id === id)
  const here = folders[at]
  if (here === undefined || here.depth === 0) return null
  for (let back = at - 1; back >= 0; back -= 1) {
    const folder = folders[back]
    if (folder !== undefined && folder.depth < here.depth) return folder
  }
  return null
}
