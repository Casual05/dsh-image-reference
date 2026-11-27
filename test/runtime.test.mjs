import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { legacyCaptionKeyOf, readSettings } from '../lib/config.js'
import { occurrenceKey } from '../lib/projection.js'
import { installImageReference } from '../lib/runtime.js'

const WRAPPER = Symbol.for('dsh-image-reference.wrapper')
const IMAGE = { attachmentId: 'original', mediaType: 'image/png', bytes: 256, width: 640, height: 360 }
const THUMB = { attachmentId: 'thumbnail', mediaType: 'image/png', bytes: 24, width: 320, height: 180 }
const MESSAGES = [{ role: 'user', id: 'image-message', content: [{ type: 'image', attachment: IMAGE }] }]
const FOLLOW_UP = [{ ...MESSAGES[0] }, { role: 'user', id: 'follow-up', content: [{ type: 'text', text: 'continue' }] }]
const FINISH = { type: 'finish', reason: { kind: 'stop' } }
const DELTA = { type: 'text-delta', text: 'fixture caption', index: 0 }

class Assembler {
  content = []
  push(chunk) {
    if (chunk.type === 'text-delta') this.content.push({ type: 'text', text: chunk.text })
  }
  blocks() {
    return this.content
  }
}

function fixture(t, settings = {}, options = {}) {
  const dir = options.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-image-reference-runtime-'))
  const file = path.join(dir, 'state.json')
  if (options.savedState !== undefined) fs.writeFileSync(file, JSON.stringify(options.savedState))
  const imagePath = (ref) => path.join(dir, ref.attachmentId)
  fs.writeFileSync(imagePath(IMAGE), Buffer.alloc(IMAGE.bytes))
  const seen = []
  const disposers = []
  const events = new Map()
  const warnings = []
  const info = []
  const entries = []
  let probeCalls = 0
  const original = {
    async prepareCall() {
      return { model: { inputModalities: ['text', 'image'] }, stream: (request) => original.stream(request) }
    },
    async *stream(request) {
      seen.push(request)
      if (request.behavior !== undefined) {
        yield* request.behavior()
        return
      }
      if (request.purpose) yield DELTA
      yield FINISH
    },
  }
  const adapters = new Map([['p', { adapter: original }], ['alias', { adapter: original }]])
  const cfg = {
    log: settings.log ?? 'off',
    features: { caption: false, thumbnail: false, keepRecentTurns: 0, ...settings.features },
    state: { persist: true, path: file, ...settings.state },
    caption: { retries: 0, ...settings.caption },
  }
  const attachments = {
    imageHostPath: imagePath,
    async readImageRequest() { return { data: Buffer.alloc(THUMB.bytes), mediaType: THUMB.mediaType } },
    async saveImage(input) {
      fs.writeFileSync(imagePath(THUMB), input.data)
      return THUMB
    },
    ...options.attachments,
  }
  const llm = {
    adapters,
    async prepareCall(route, signal) {
      probeCalls += 1
      if (options.prepareCall !== undefined) return options.prepareCall(route, signal)
      return { config: route, inputModalities: ['image'], stream: (request) => original.stream(request) }
    },
  }
  installImageReference({
    llm, attachments, logger: {
      info(message) { info.push(message) },
      warn(message) { warnings.push(message) },
    },
    get(key) {
      if (key === 'fs') return { processPathFromHostPath: (hostPath) => hostPath }
      if (key === 'loader') return { entries: () => entries }
    },
    on: (event, handler) => events.set(event, handler),
    effect: (apply) => disposers.push(apply()),
  }, cfg, {
    BlockAssembler: Assembler,
    createUserMessage: (input) => ({ role: 'user', ...input }),
    resolveImageAttachmentAccess: (store, map, ref) => ({ readonlyPath: map(store.imageHostPath(ref)) }),
  })
  let closed
  const close = () => closed ??= Promise.all(disposers.map((dispose) => dispose()))
  t.after(async () => {
    await close()
    if (options.dir === undefined) fs.rmSync(dir, { recursive: true, force: true })
  })

  async function request(extra = {}, prepared = false) {
    const adapter = adapters.get('p').adapter
    const req = { provider: 'p', model: 'm', sessionId: 's', messages: MESSAGES, ...extra }
    const call = prepared ? await adapter.prepareCall(req.provider, req.model) : adapter
    for await (const _chunk of call.stream(req)) {}
    return seen.filter((item) => !item.purpose).at(-1)
  }
  return { adapters, cfg, close, dir, entries, events, file, imagePath, info, original, seen, warnings, request, probeCalls: () => probeCalls }
}

const firstBlock = (request) => request.messages[0].content[0]
const tick = () => new Promise(setImmediate)

test('流错误、空流、中断均不记账，重试继续发送图片', async (t) => {
  const fx = fixture(t)
  const modes = [
    async function* () { yield { type: 'finish', reason: { kind: 'error' } } },
    async function* () { yield DELTA; yield { type: 'finish', reason: { kind: 'error' } } },
    async function* () { yield DELTA; yield { type: 'finish', reason: { kind: 'aborted' } } },
    async function* () {},
  ]
  for (const [index, behavior] of modes.entries()) {
    const sessionId = String(index)
    await fx.request({ sessionId, behavior })
    assert.equal(firstBlock(await fx.request({ sessionId })).type, 'image')
    assert.equal(firstBlock(await fx.request({ sessionId })).type, 'text')
  }
  await assert.rejects(fx.request({
    sessionId: 'late-throw',
    async *behavior() { yield DELTA; throw new Error('connection lost') },
  }), /connection lost/u)
  assert.equal(firstBlock(await fx.request({ sessionId: 'late-throw' })).type, 'image')
  const cancellation = fx.adapters.get('p').adapter.stream({
    provider: 'p', model: 'm', sessionId: 'consumer-break', messages: MESSAGES,
    async *behavior() { yield DELTA; yield FINISH },
  })
  for await (const _chunk of cancellation) break
  assert.equal(firstBlock(await fx.request({ sessionId: 'consumer-break' })).type, 'image')
})

test('成功才落盘，重启后使用引用，当前轮保留原图', async (t) => {
  const fx = fixture(t, { features: { keepRecentTurns: 1 } })
  assert.equal(firstBlock(await fx.request()).type, 'image')
  assert.equal(firstBlock(await fx.request()).type, 'image')
  await fx.close()
  const resumed = fixture(t, { features: { keepRecentTurns: 1 } }, { dir: fx.dir })
  assert.equal(firstBlock(await resumed.request({ messages: FOLLOW_UP })).type, 'text')
  await resumed.close()
})

test('已准备的模型能力直接复用，未知探测永久挂起也不挡主流', async (t) => {
  const fx = fixture(t, { features: { thumbnail: true } }, { prepareCall: () => new Promise(() => {}) })
  await fx.request({}, true)
  assert.equal(fx.probeCalls(), 0)
  const result = await Promise.race([
    fx.request({ model: 'unknown', sessionId: 'unknown-session' }),
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('等待能力探测阻塞了主流')), 500)
      timer.unref()
    }),
  ])
  assert.equal(firstBlock(result).type, 'image')
  assert.equal(fx.probeCalls(), 1)
})

test('包裹器跨 provider 别名保持身份，冲突时恢复，卸载时不覆盖第三方重挂', async (t) => {
  const fx = fixture(t)
  const wrapper = fx.adapters.get('p').adapter
  assert.equal(wrapper, fx.adapters.get('alias').adapter)
  assert.equal(wrapper[WRAPPER], true)
  fx.entries.push({ options: { name: 'dsh-image-once' } })
  fx.events.get('loader/config-update')()
  assert.equal(fx.adapters.get('p').adapter, fx.original)
  assert.ok(fx.warnings.some((warning) => warning.includes('dsh-image-once')))
  fx.entries.length = 0
  fx.events.get('loader/config-update')()
  assert.equal(fx.adapters.get('p').adapter, wrapper)
  const newer = { async *stream() { yield FINISH } }
  fx.adapters.set('p', { adapter: newer })
  await fx.close()
  assert.equal(fx.adapters.get('p').adapter, newer)
  assert.equal(fx.adapters.get('alias').adapter, fx.original)
})

test('描述设置变化后会补生成，描述请求不会触发插件递归', async (t) => {
  const fx = fixture(t)
  await fx.request({}, true)
  fx.cfg.features.caption = true
  assert.equal(firstBlock(await fx.request({}, true)).type, 'image')
  await tick()
  const withCaption = await fx.request({}, true)
  assert.match(firstBlock(withCaption).text, /fixture caption/u)
  const captionRequest = fx.seen.find((request) => request.purpose === 'image-reference-caption')
  assert.equal(captionRequest.messages[0].content[1].type, 'image')
  fx.cfg.caption.provider = 'ocr'
  fx.cfg.caption.model = 'vision'
  assert.equal(firstBlock(await fx.request({}, true)).type, 'image')
  await tick()
  assert.match(firstBlock(await fx.request({}, true)).text, /fixture caption/u)
  assert.equal(fx.seen.filter((request) => request.purpose).length, 2)
})

test('报错预设把第 17 行存成独立字段并带入下一次历史请求', async (t) => {
  let captionCalls = 0
  const fx = fixture(t, { features: { caption: true }, caption: { preset: 'auto' } }, {
    prepareCall: async (route) => ({
      config: route, inputModalities: ['image'],
      async *stream(request) {
        captionCalls += 1
        assert.match(request.system, /Choose "error-screenshot"/u)
        yield { ...DELTA, text: JSON.stringify({
          preset: 'error-screenshot', errorMessage: 'TypeError', file: 'app.ts', line: 17,
          code: [{ line: 17, text: 'items.map(renderItem)' }],
        }) }
        yield FINISH
      },
    }),
  })
  assert.equal(firstBlock(await fx.request({}, true)).type, 'image')
  await tick()
  const history = firstBlock(await fx.request({ messages: FOLLOW_UP }, true))
  assert.equal(history.type, 'text')
  assert.match(history.text, /Code 17 \| items\.map\(renderItem\)/u)
  assert.equal(captionCalls, 1)
  await fx.close()
  const snapshot = JSON.parse(fs.readFileSync(fx.file, 'utf8'))
  const [cached] = Object.values(snapshot.captions)
  assert.equal(cached.data.preset, 'error-screenshot')
  assert.deepEqual(cached.data.code, [{ line: 17, text: 'items.map(renderItem)' }])
})

test('自动预设升级使用旧描述维持减载，随后换成结构化描述', async (t) => {
  const key = occurrenceKey('s', MESSAGES[0], '0', MESSAGES[0].content[0])
  const legacy = legacyCaptionKeyOf(IMAGE.attachmentId, readSettings({}).caption, { provider: 'p', model: 'm' })
  const fx = fixture(t, { features: { caption: true } }, {
    savedState: { version: 1, sent: { [key]: 1 }, captions: { [legacy]: { text: 'old caption' } } },
    prepareCall: async (route) => ({
      config: route, inputModalities: ['image'],
      async *stream() {
        yield { ...DELTA, text: '{"preset":"standard","summary":"new structured caption"}' }
        yield FINISH
      },
    }),
  })
  const before = firstBlock(await fx.request({}, true))
  assert.equal(before.type, 'text')
  assert.match(before.text, /old caption/u)
  await tick()
  const after = firstBlock(await fx.request({}, true))
  assert.match(after.text, /Summary: new structured caption/u)
})

test('失效缩略图退回描述，原生已卸载图片始终为文本', async (t) => {
  const fx = fixture(t, { features: { caption: true, thumbnail: true } })
  await fx.request({}, true)
  await tick()
  const withThumb = await fx.request({}, true)
  assert.equal(firstBlock(withThumb).attachment.attachmentId, THUMB.attachmentId)
  const offloaded = [{ ...MESSAGES[0], content: [{ ...MESSAGES[0].content[0], offloaded: true }] }]
  const omitted = await fx.request({ messages: offloaded }, true)
  assert.deepEqual(omitted.messages[0].content.map(({ type }) => type), ['text'])
  fs.unlinkSync(fx.imagePath(THUMB))
  const result = await fx.request({}, true)
  assert.equal(firstBlock(result).type, 'text')
  assert.match(firstBlock(result).text, /fixture caption/u)
})

test('描述先就绪并成功发送后，后到缩略图不会改写前缀', async (t) => {
  let releaseThumbnail
  const delayed = new Promise((resolve) => { releaseThumbnail = resolve })
  const fx = fixture(t, { features: { caption: true, thumbnail: true } }, {
    attachments: { async readImageRequest() { return delayed } },
  })
  await fx.request({}, true)
  await tick()
  const description = firstBlock(await fx.request({}, true))
  assert.match(description.text, /fixture caption/u)
  releaseThumbnail({ data: Buffer.alloc(THUMB.bytes), mediaType: THUMB.mediaType })
  await tick()
  assert.deepEqual(firstBlock(await fx.request({}, true)), description)
})

test('描述和缩略图失败后使用路径，持续故障不重发原图且日志去重', async (t) => {
  let captionCalls = 0
  const fx = fixture(t, { log: 'summary', features: { caption: true, thumbnail: true } }, {
    attachments: { async readImageRequest() { throw new Error('cannot resize') } },
    prepareCall: async (route) => {
      captionCalls += 1
      return {
        config: route, inputModalities: ['image'],
        async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider unavailable' } } } },
      }
    },
  })
  assert.equal(firstBlock(await fx.request({}, true)).type, 'image')
  await tick()
  for (let n = 0; n < 2; n += 1) {
    const block = firstBlock(await fx.request({}, true))
    assert.equal(block.type, 'text')
    assert.match(block.text, /Read-only local copy/u)
    assert.doesNotMatch(block.text, /Auto-generated/u)
  }
  assert.equal(captionCalls, 1)
  assert.equal(fx.info.filter((message) => message.includes('1 张使用本地路径引用')).length, 1)
})

test('冷却时先用小图，描述恢复后自动升级并保持稳定', async (t) => {
  let fail = true
  let captionCalls = 0
  const fx = fixture(t, { features: { caption: true, thumbnail: true } }, {
    prepareCall: async (route) => {
      captionCalls += 1
      return {
        config: route, inputModalities: ['image'],
        async *stream() {
          if (fail) yield { type: 'finish', reason: { kind: 'error', failure: { message: 'provider unavailable' } } }
          else { yield DELTA; yield FINISH }
        },
      }
    },
  })
  await fx.request({}, true)
  await tick()
  const thumbnail = await fx.request({}, true)
  assert.equal(firstBlock(thumbnail).attachment.attachmentId, THUMB.attachmentId)
  assert.doesNotMatch(thumbnail.messages[0].content[1].text, /fixture caption/u)
  fail = false
  fx.cfg.caption.cooldownMs = 0
  await fx.request({}, true)
  await tick()
  const upgraded = await fx.request({}, true)
  assert.match(upgraded.messages[0].content[1].text, /fixture caption/u)
  assert.deepEqual((await fx.request({}, true)).messages, upgraded.messages)
  assert.equal(captionCalls, 2)
  await fx.close()
  const disk = JSON.parse(fs.readFileSync(fx.file, 'utf8'))
  assert.deepEqual(Object.values(disk.forms).map(({ form }) => form), ['both'])
})

test('只清描述后沿用路径，多个历史图无需一起重发原图', async (t) => {
  const fx = fixture(t, { features: { caption: true, thumbnail: false } })
  const images = [MESSAGES[0], { ...MESSAGES[0], id: 'second-appearance' }]
  await fx.request({ messages: images }, true)
  await tick()
  const before = await fx.request({ messages: images }, true)
  assert.ok(before.messages.every((msg) => /fixture caption/u.test(msg.content[0].text)))
  fx.cfg.state.clearCaptionsToken = 1
  await fx.events.get('loader/volatile-update')()
  const rebuilding = await fx.request({ messages: images }, true)
  for (const { content: [block] } of rebuilding.messages) {
    assert.equal(block.type, 'text')
    assert.match(block.text, /Read-only local copy/u)
    assert.doesNotMatch(block.text, /fixture caption/u)
  }
  await tick()
  const after = await fx.request({ messages: images }, true)
  assert.ok(after.messages.every((msg) => /fixture caption/u.test(msg.content[0].text)))
})

test('能力未知的请求成功也不记账，切到确认支持读图的路由才记账', async (t) => {
  const fx = fixture(t, {}, { prepareCall: async () => ({}) })
  assert.equal(firstBlock(await fx.request()).type, 'image')
  await tick()
  assert.equal(firstBlock(await fx.request()).type, 'image')
  assert.equal(fs.existsSync(fx.file), false)
  const vision = { model: 'explicit-vision' }
  assert.equal(firstBlock(await fx.request(vision, true)).type, 'image')
  assert.equal(firstBlock(await fx.request(vision, true)).type, 'text')
  await fx.close()
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(fx.file, 'utf8')).sent).length, 1)
})

test('清空操作取消在飞描述，忽略无视取消信号的晚到结果', async (t) => {
  let releaseCaption
  const delayed = new Promise((resolve) => { releaseCaption = resolve })
  let captionSignal
  const fx = fixture(t, { features: { caption: true } }, {
    prepareCall: async (route) => ({
      config: route, inputModalities: ['image'],
      async *stream(options) {
        captionSignal = options.signal
        await delayed
        yield DELTA
        yield FINISH
      },
    }),
  })
  await fx.request({}, true)
  await tick()
  assert.equal(captionSignal.aborted, false)
  fx.cfg.state.clearToken = 1
  await fx.events.get('loader/volatile-update')()
  assert.equal(captionSignal.aborted, true)
  releaseCaption()
  await tick()
  await fx.close()
  const disk = JSON.parse(fs.readFileSync(fx.file, 'utf8'))
  assert.deepEqual(disk.sent, {})
  assert.deepEqual(disk.captions, {})
})
