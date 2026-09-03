import { randomUUID } from 'node:crypto'
import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024
export const ATTACHMENT_RETENTION_MS = 24 * 60 * 60 * 1_000
export const DEFAULT_ATTACHMENT_DIRECTORY = join(tmpdir(), 'orca-control-room-attachments')

const generatedAttachmentPattern = /^clipboard-\d+-[0-9a-f-]+\.(?:png|jpe?g|webp|gif)$/i

function startsWith(buffer, bytes) {
  return bytes.every((byte, index) => buffer[index] === byte)
}

export function detectImageType(buffer) {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { extension: 'png', mimeType: 'image/png' }
  }
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) {
    return { extension: 'jpg', mimeType: 'image/jpeg' }
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { extension: 'webp', mimeType: 'image/webp' }
  }
  const header = buffer.subarray(0, 6).toString('ascii')
  if (header === 'GIF87a' || header === 'GIF89a') {
    return { extension: 'gif', mimeType: 'image/gif' }
  }
  throw new Error('Clipboard attachment must be a PNG, JPEG, WebP, or GIF image')
}

export async function cleanupAttachments(
  directory = DEFAULT_ATTACHMENT_DIRECTORY,
  now = Date.now()
) {
  let entries
  try {
    entries = await readdir(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  await Promise.all(
    entries.filter((name) => generatedAttachmentPattern.test(name)).map(async (name) => {
      const path = join(directory, name)
      try {
        const details = await stat(path)
        if (details.isFile() && now - details.mtimeMs > ATTACHMENT_RETENTION_MS) {
          await unlink(path)
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
    })
  )
}

export async function saveClipboardImage(buffer, directory = DEFAULT_ATTACHMENT_DIRECTORY) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Image is empty')
  if (buffer.length > MAX_ATTACHMENT_BYTES) throw new Error('Image exceeds the 12 MiB limit')
  const imageType = detectImageType(buffer)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await cleanupAttachments(directory)
  const name = `clipboard-${Date.now()}-${randomUUID()}.${imageType.extension}`
  const path = join(directory, name)
  await writeFile(path, buffer, { flag: 'wx', mode: 0o600 })
  return {
    path,
    name,
    size: buffer.length,
    mimeType: imageType.mimeType
  }
}
