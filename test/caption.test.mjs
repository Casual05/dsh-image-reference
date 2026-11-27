import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'

import { captionKeyOf, readSettings } from '../lib/config.js'
import { CaptionService } from '../lib/caption.js'
import { StateStore } from '../lib/state.js'

const REF = { attachmentId: 'sha256:aaaa', mediaType: 'image/png', bytes: 10, width: 640, height: 360 }
const ROUTE = { provider: 'p', model: 'm' }

function makeState() {
  const store = new StateStore({
    file: path.join(os.tmpdir(), `dsh-image-reference-caption-${Date.now()}.json`),
    persist: false,
    logger: { warn() {} },
  })
  store.load()
  return store
}

class FakeAssembler {
  constructor() {
    this._blocks = []
  }

  push(chunk) {
    if (chunk?.type !== 'text-delta') return
    const last = this._blocks[this._blocks.length - 1]
    if (last?.type === 'text') last.text += chunk.text
    else this._blocks.push({ type: 'text', text: chunk.text })
  }

  blocks() {
    return this._blocks
  }
}

function fakeCreateUserMessage(input) {
  return { role: 'user', content: input.content, source: input.source }
}

function makeLlm(options = {}) {
  const state = {
    calls: 0,
    systems: [],
    options: [],
    failuresLeft: options.failures ?? 0,
  }
  return {
    state,
    async prepareCall(config) {
      state.calls += 1
      if (state.failuresLeft > 0) {
        state.failuresLeft -= 1
        throw new Error('boom')
      }
      return {
        config: { provider: config.provider, model: config.model },
        inputModalities: options.modalities ?? ['text', 'image'],
        stream: async function* (request) {
          state.systems.push(request.system)
          state.options.push(request)
          if (options.hang === true) {
            await new Promise((_, reject) => {
              const signal = request.signal
              if (signal?.aborted) {
                reject(signal.reason ?? new Error('aborted'))
                return
              }
              signal?.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true })
            })
          }
          yield { type: 'text-delta', index: 0, text: options.text ?? '一张报错截图' }
          yield { type: 'finish', reason: options.finish ?? { kind: 'stop' } }
        },
      }
    },
  }
}

function makeService(overrides = {}) {
  const settings = overrides.settings ?? readSettings({
    caption: { retries: 0, retryDelayMs: 1, timeoutMs: 5_000 },
  })
  const state = overrides.state ?? makeState()
  const llm = overrides.llm ?? makeLlm()
  const service = new CaptionService({
    llm,
    createUserMessage: fakeCreateUserMessage,
    BlockAssembler: FakeAssembler,
    settings: () => settings,
    state,
    retryDelayMs: 1,
    logger: { info() {}, warn() {} },
  })
  return { service, state, llm, settings }
}

test('成功生成描述并写入缓存', async () => {
  const { service, state, llm, settings } = makeService()
  service.enqueue({ ref: REF, provider: 'p', model: 'm' })
  await service.drain()
  const key = captionKeyOf(REF.attachmentId, settings.caption, ROUTE)
  assert.equal(state.getCaptionText(key), '一张报错截图')
  assert.equal(llm.state.calls, 1)
  assert.equal(service.stats().ok, 1)
})

test('模型没有图片能力时不发请求，直接记失败', async () => {
  const { service, state, settings, llm } = makeService({
    llm: makeLlm({ modalities: ['text', 'reasoning'] }),
    settings: readSettings({ caption: { retries: 2 } }),
  })
  service.enqueue({ ref: REF, provider: 'p', model: 'm' })
  await service.drain()
  const key = captionKeyOf(REF.attachmentId, settings.caption, ROUTE)
  assert.equal(state.getCaptionText(key), undefined)
  assert.match(state.data.failures[key].reason, /no image modality/u)
  assert.equal(llm.state.calls, 1)
  assert.equal(llm.state.options.length, 0)
})

test('失败后按 retries 重试', async () => {
  const { service, state, settings } = makeService({
    llm: makeLlm({ failures: 1 }),
    settings: readSettings({ caption: { retries: 1, timeoutMs: 5_000 } }),
  })
  service.enqueue({ ref: REF, provider: 'p', model: 'm' })
  await service.drain()
  const key = captionKeyOf(REF.attachmentId, settings.caption, ROUTE)
  assert.equal(state.getCaptionText(key), '一张报错截图')
  assert.equal(service.stats().ok, 1)
})

test('同一张图重复入队只发一次', async () => {
  const { service, llm } = makeService()
  service.enqueue({ ref: REF, provider: 'p', model: 'm' })
  service.enqueue({ ref: { ...REF }, provider: 'p', model: 'm' })
  await service.drain()
  assert.equal(llm.state.calls, 1)
})

test('已有缓存时不再请求', async () => {
  const settings = readSettings({})
  const state = makeState()
  const key = captionKeyOf(REF.attachmentId, settings.caption, ROUTE)
  state.putCaption(key, { text: '缓存里的描述' })
  const llm = makeLlm()
  const service = new CaptionService({
    llm,
    createUserMessage: fakeCreateUserMessage,
    BlockAssembler: FakeAssembler,
    settings: () => settings,
    state,
    logger: { info() {}, warn() {} },
  })
  service.enqueue({ ref: REF, provider: 'p', model: 'm' })
  await service.drain()
  assert.equal(llm.state.calls, 0)
  assert.equal(service.stats().skipped, 1)
})

test('超时记失败并冷却', async () => {
  const { service, state, settings } = makeService({
    llm: makeLlm({ hang: true }),
    settings: readSettings({ caption: { retries: 0, timeoutMs: 30 } }),
  })
  service.enqueue({ ref: REF, provider: 'p', model: 'm' })
  await service.drain()
  const key = captionKeyOf(REF.attachmentId, settings.caption, ROUTE)
  assert.equal(state.getCaptionText(key), undefined)
  assert.match(state.data.failures[key].reason, /TimeoutError|abort/iu)
})

test('自定义 prompt 覆盖内置 system', async () => {
  const { service, llm } = makeService({
    settings: readSettings({ caption: { prompt: 'CUSTOM SYSTEM', retries: 0, timeoutMs: 5_000 } }),
  })
  service.enqueue({ ref: REF, provider: 'p', model: 'm' })
  await service.drain()
  assert.equal(llm.state.systems[0], 'CUSTOM SYSTEM')
})

test('有局部 OCR 输出的错误流不能写入成功缓存', async () => {
  const { service, state, settings } = makeService({
    llm: makeLlm({ finish: { kind: 'error', failure: { message: 'broken connection' } } }),
  })
  service.enqueue({ ref: REF, ...ROUTE })
  await service.drain()
  const key = captionKeyOf(REF.attachmentId, settings.caption, ROUTE)
  assert.equal(state.getCaptionText(key), undefined)
  assert.match(state.data.failures[key].reason, /broken connection/u)
})

test('停止会取消在飞描述，且取消后不重试和写入失败冷却', async () => {
  const { service, state, llm } = makeService({
    llm: makeLlm({ hang: true }),
    settings: readSettings({ caption: { retries: 2 } }),
  })
  service.enqueue({ ref: REF, ...ROUTE })
  await Promise.resolve()
  assert.equal(llm.state.options.length, 1)
  service.stop()
  await service.drain()
  assert.equal(llm.state.options[0].signal.aborted, true)
  assert.equal(llm.state.calls, 1)
  assert.equal(state.stats().failures, 0)
})
