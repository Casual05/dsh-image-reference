import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'

import { readSettings, thumbKeyOf } from '../lib/config.js'
import { ThumbnailService, longEdgeDimensions } from '../lib/thumbnail.js'
import { StateStore } from '../lib/state.js'

const REF = { attachmentId: 'sha256:aaaa', mediaType: 'image/png', bytes: 10, width: 1920, height: 1080 }

function makeState() {
  const store = new StateStore({
    file: path.join(os.tmpdir(), `dsh-image-reference-thumb-${Date.now()}.json`),
    persist: false,
    logger: { warn() {} },
  })
  store.load()
  return store
}

function makeAttachments(options = {}) {
  const calls = { read: 0, save: 0 }
  return {
    calls,
    async readImageRequest(ref, target) {
      calls.read += 1
      if (options.fail === true) throw new Error('read failed')
      return { data: new Uint8Array([1, 2, 3]), mediaType: ref.mediaType, width: target.width, height: target.height }
    },
    async saveImage(input) {
      calls.save += 1
      return {
        attachmentId: 'sha256:thumb',
        mediaType: input.mediaType,
        bytes: input.data.length,
        width: 320,
        height: 180,
      }
    },
  }
}

test('longEdgeDimensions 等比缩放、只缩不放', () => {
  assert.deepEqual(longEdgeDimensions(1920, 1080, 320), { width: 320, height: 180 })
  assert.deepEqual(longEdgeDimensions(1080, 1920, 320), { width: 180, height: 320 })
  assert.deepEqual(longEdgeDimensions(200, 100, 320), { width: 200, height: 100 })
  assert.deepEqual(longEdgeDimensions(1, 1, 320), { width: 1, height: 1 })
})

test('成功生成并缓存缩略图', async () => {
  const settings = readSettings({})
  const state = makeState()
  const attachments = makeAttachments()
  const service = new ThumbnailService({ attachments, settings: () => settings, state, logger: { info() {}, warn() {} } })
  service.enqueue({ ref: REF })
  await service.drain()
  const key = thumbKeyOf(REF.attachmentId, settings.thumbnail)
  assert.equal(state.getThumb(key).attachmentId, 'sha256:thumb')
  assert.equal(attachments.calls.read, 1)
  assert.equal(attachments.calls.save, 1)
  assert.equal(service.stats().ok, 1)
})

test('同一张图重复入队只生成一次', async () => {
  const settings = readSettings({})
  const state = makeState()
  const attachments = makeAttachments()
  const service = new ThumbnailService({ attachments, settings: () => settings, state, logger: { info() {}, warn() {} } })
  service.enqueue({ ref: REF })
  service.enqueue({ ref: { ...REF } })
  await service.drain()
  assert.equal(attachments.calls.read, 1)
})

test('失败后记冷却，重复入队被跳过', async () => {
  const settings = readSettings({})
  const state = makeState()
  const attachments = makeAttachments({ fail: true })
  const service = new ThumbnailService({ attachments, settings: () => settings, state, logger: { info() {}, warn() {} } })
  service.enqueue({ ref: REF })
  await service.drain()
  service.enqueue({ ref: REF })
  await service.drain()
  assert.equal(attachments.calls.read, 1)
  assert.equal(service.stats().skipped, 1)
})
