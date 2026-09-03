import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ATTACHMENT_RETENTION_MS,
  cleanupAttachments,
  detectImageType,
  saveClipboardImage
} from '../companion/attachments.mjs'

test('detectImageType recognizes supported image signatures', () => {
  assert.deepEqual(detectImageType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), {
    extension: 'png',
    mimeType: 'image/png'
  })
  assert.equal(detectImageType(Buffer.from([0xff, 0xd8, 0xff])).extension, 'jpg')
  assert.equal(detectImageType(Buffer.from('GIF89a')).extension, 'gif')
  assert.equal(detectImageType(Buffer.from('RIFF....WEBP')).extension, 'webp')
  assert.throws(() => detectImageType(Buffer.from('not an image')), /must be a PNG/)
})

test('saveClipboardImage writes a private file and cleanup removes only expired attachments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'control-room-attachments-test-'))
  try {
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const saved = await saveClipboardImage(image, directory)
    assert.deepEqual(await readFile(saved.path), image)
    assert.equal((await stat(saved.path)).mode & 0o777, 0o600)

    const unrelated = join(directory, 'keep-me.txt')
    await writeFile(unrelated, 'keep')
    const expiredAt = new Date(Date.now() - ATTACHMENT_RETENTION_MS - 1_000)
    await utimes(saved.path, expiredAt, expiredAt)
    await cleanupAttachments(directory)

    await assert.rejects(stat(saved.path), /ENOENT/)
    assert.equal(await readFile(unrelated, 'utf8'), 'keep')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
