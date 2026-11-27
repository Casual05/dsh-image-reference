import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { StateStore } from '../lib/state.js'

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-image-reference-'))
}

function makeStore(file, extra = {}) {
  return new StateStore({ file, persist: true, maxOccurrences: 100, maxEntries: 100, logger: { warn() {} }, ...extra })
}

test('markSent 落盘后可被新实例读回', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'state.json')
  const store = makeStore(file)
  store.load()
  store.markSent(['a', 'b'])
  await store.flush()
  await store.close()

  const next = makeStore(file)
  next.load()
  assert.equal(next.isSent('a'), true)
  assert.equal(next.isSent('b'), true)
  assert.equal(next.isSent('c'), false)
  await next.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('损坏的 JSON 会备份并重建，不抛错', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'state.json')
  fs.writeFileSync(file, '{ not json', 'utf8')
  const store = makeStore(file)
  store.load()
  assert.equal(store.isSent('a'), false)
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith('state.json.bad-'))
  assert.equal(backups.length, 1)
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('发送记录按数值时间淘汰，与插入顺序无关', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'state.json')
  const store = makeStore(file, { maxOccurrences: 2 })
  store.load()
  store.data.sent = { new: 1000, mid: 900, old: 5 }
  store.dirty = true
  await store.flush()
  const kept = Object.keys(store.data.sent).sort()
  assert.deepEqual(kept, ['mid', 'new'])
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('caption / thumb 条目读写与损坏条目防御', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'state.json')
  const store = makeStore(file)
  store.load()
  store.putCaption('k', { text: '描述', model: 'p/m', style: 'structured', language: 'en', chars: 2 })
  store.putThumb('t', { attachmentId: 'sha256:x', mediaType: 'image/jpeg', bytes: 3, width: 10, height: 10 })
  assert.equal(store.getCaptionText('k'), '描述')
  assert.equal(store.getThumb('t').attachmentId, 'sha256:x')
  assert.equal(store.getThumb('missing'), undefined)
  assert.equal(store.getCaptionText('missing'), undefined)
  store.data.thumbs.broken = { ref: { attachmentId: 5 } }
  assert.equal(store.getThumb('broken'), undefined)
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('clearAll 清空全部缓存', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'state.json')
  const store = makeStore(file)
  store.load()
  store.markSent(['a'])
  store.putCaption('k', { text: 'x' })
  await store.clearAll()
  assert.equal(store.isSent('a'), false)
  assert.equal(store.getCaptionText('k'), undefined)
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('persist=false 不写文件', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'state.json')
  const store = makeStore(file, { persist: false })
  store.load()
  store.markSent(['a'])
  await store.flush()
  await store.close()
  assert.equal(fs.existsSync(file), false)
  assert.equal(store.isSent('a'), true)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('失败冷却按 cooldownMs 生效', async () => {
  const dir = tempDir()
  const file = path.join(dir, 'state.json')
  const store = makeStore(file)
  store.load()
  const now = Date.now()
  store.markFailure('k', 'timeout')
  assert.equal(store.isCooling('k', 60_000, now), true)
  assert.equal(store.isCooling('k', 60_000, now + 61_000), false)
  assert.equal(store.isCooling('other', 60_000, now), false)
  await store.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('写入期间清空，最终快照保持清空结果', async (t) => {
  const dir = tempDir()
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'state.json')
  const store = makeStore(file)
  store.markSent(['a'])
  store.putCaption('c', { text: 'removed' })
  const firstWrite = store.flush()
  await new Promise(setImmediate)
  await store.clearAll()
  await firstWrite
  await store.close()

  const disk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(disk.sent, {})
  assert.deepEqual(disk.captions, {})
  assert.deepEqual(fs.readdirSync(dir), ['state.json'])
})

test('只清描述时保留发送记录、缩略图和缩略图冷却', async () => {
  const store = makeStore('unused', { persist: false })
  store.markSent(['a'])
  store.putForm('a', 'policy', 'both')
  store.putCaption('c', { text: 'removed' })
  store.putThumb('t', { attachmentId: 'thumbnail' })
  store.markFailure('c', 'caption failed')
  store.markFailure('thumb:t', 'thumbnail failed')
  await store.clearCaches(['captions'])
  assert.equal(store.getCaptionText('c'), undefined)
  assert.equal(store.getForm('a', 'policy'), 'both')
  assert.equal(store.isSent('a'), true)
  assert.equal(store.getThumb('t').attachmentId, 'thumbnail')
  assert.equal(store.isCooling('c', 600_000), false)
  assert.equal(store.isCooling('thumb:t', 600_000), true)
  await store.close()
})

test('原子替换失败保留旧文件，并在没有新写入时自动重试', async (t) => {
  const dir = tempDir()
  const file = path.join(dir, 'state.json')
  const previous = { version: 1, sent: { old: 1 } }
  fs.writeFileSync(file, JSON.stringify(previous))
  let attempts = 0
  let signalRetry
  const replaced = new Promise((resolve) => { signalRetry = resolve })
  const store = makeStore(file, {
    async replaceFile(from, to) {
      attempts += 1
      if (attempts === 1) throw Object.assign(new Error('Windows file temporarily locked'), { code: 'EPERM' })
      await fs.promises.rename(from, to)
      signalRetry()
    },
  })
  t.after(async () => {
    await store.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  store.load()
  store.markSent(['new'])
  await store.flush()
  assert.equal(store.dirty, true)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), previous)
  assert.deepEqual(fs.readdirSync(dir), ['state.json'])

  let deadline
  try {
    await Promise.race([replaced, new Promise((_, reject) => {
      deadline = setTimeout(() => reject(new Error('没有自动重试写盘')), 5_000)
    })])
  } finally {
    clearTimeout(deadline)
  }
  assert.equal(attempts, 2)
  assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, 'utf8')).sent, 'new'), true)
})

test('关闭持久化仍执行容量淘汰', async () => {
  const store = makeStore('unused', { persist: false, maxOccurrences: 1 })
  store.data.sent = { newer: 100, older: 1 }
  store.putForm('older', 'policy', 'caption')
  await store.close()
  assert.deepEqual(Object.keys(store.data.sent), ['newer'])
  assert.deepEqual(store.data.forms, {})
})
