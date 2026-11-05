import { lstatSync, readFileSync, realpathSync, unlinkSync, type Stats } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, relative, sep } from 'node:path'

export const captureByteLimit = 1_500_000
export const captureEdgeLimit = 1_280

const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export class CaptureFileError extends Error {
  constructor(
    readonly code: 'outside_directory' | 'permissions' | 'too_large' | 'not_png' | 'empty'
  ) {
    super(code)
    this.name = 'CaptureFileError'
  }
}

export function readOwnedCapture(input: {
  filePath: string
  directory: string
  maxBytes?: number
}): Buffer {
  const maxBytes = input.maxBytes ?? captureByteLimit
  const directory = ownedDirectory(input.directory)
  const listed = lstatSync(input.filePath)
  if (listed.isSymbolicLink() || !listed.isFile()) {
    throw new CaptureFileError('outside_directory')
  }
  assertPrivate(listed)
  if (listed.size <= 0) {
    throw new CaptureFileError('empty')
  }
  if (listed.size > maxBytes) {
    throw new CaptureFileError('too_large')
  }
  const file = realpathSync(input.filePath)
  if (!inside(directory, file)) {
    throw new CaptureFileError('outside_directory')
  }
  const bytes = readFileSync(file)
  if (bytes.length !== listed.size || bytes.length > maxBytes) {
    throw new CaptureFileError('too_large')
  }
  if (!bytes.subarray(0, pngSignature.length).equals(pngSignature)) {
    throw new CaptureFileError('not_png')
  }
  return bytes
}

export function safeUnlink(filePath: string, directory: string): void {
  try {
    const root = realpathSync(tmpdir())
    const dir = realpathSync(directory)
    if (!inside(root, dir)) {
      return
    }
    const listed = lstatSync(filePath)
    if (listed.isSymbolicLink()) {
      const parent = realpathSync(dirname(filePath))
      if (parent === dir || inside(dir, parent)) {
        unlinkSync(filePath)
      }
      return
    }
    if (!listed.isFile()) {
      return
    }
    const file = realpathSync(filePath)
    if (inside(dir, file)) {
      unlinkSync(file)
    }
  } catch {
    return
  }
}

function ownedDirectory(directory: string): string {
  const root = realpathSync(tmpdir())
  const dirStat = lstatSync(directory)
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new CaptureFileError('outside_directory')
  }
  assertPrivate(dirStat)
  const dir = realpathSync(directory)
  if (!inside(root, dir)) {
    throw new CaptureFileError('outside_directory')
  }
  return dir
}

function assertPrivate(stat: Stats): void {
  if ((stat.mode & 0o077) !== 0) {
    throw new CaptureFileError('permissions')
  }
  const uid = process.getuid?.()
  if (uid !== undefined && stat.uid !== uid) {
    throw new CaptureFileError('permissions')
  }
}

function inside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
