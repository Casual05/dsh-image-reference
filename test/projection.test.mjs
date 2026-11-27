import test from 'node:test'
import assert from 'node:assert/strict'

import { hasImageDeep, occurrenceKey, projectMessages } from '../lib/projection.js'

function image(id = 'sha256:aaaa', extra = {}) {
  return {
    type: 'image',
    attachment: { attachmentId: id, mediaType: 'image/png', bytes: 10, width: 640, height: 360, ...extra },
  }
}

function userMessage(...content) {
  return { role: 'user', id: 'm1', content }
}

function makeEnv(overrides = {}) {
  const sent = new Set()
  return {
    sessionId: 's1',
    sent,
    hasSent: (key) => sent.has(key),
    minImages: 1,
    features: { caption: false, thumbnail: false, minImages: 1 },
    captionFor: () => undefined,
    thumbFor: () => undefined,
    supportsImage: true,
    pathFor: () => 'C:\\tmp\\image.png',
    language: 'en',
    ...overrides,
  }
}

test('首次出现原样保留并进入 pending', () => {
  const env = makeEnv()
  const block = image()
  const messages = [userMessage(block)]
  const result = projectMessages(messages, env)
  assert.equal(result.messages, messages)
  assert.equal(result.messages[0].content[0], block)
  assert.equal(result.pending.length, 1)
  assert.equal(result.pending[0].key, occurrenceKey('s1', { id: 'm1' }, '0', block))
  assert.equal(result.replaced, 0)
})

test('已发送的图片替换成文本，且不丢图片之后的块', () => {
  const env = makeEnv()
  const block = image()
  env.sent.add(occurrenceKey('s1', { id: 'm1' }, '1', block))

  const first = { type: 'text', text: 'A' }
  const last = { type: 'text', text: 'B' }
  const result = projectMessages([userMessage(first, block, last)], env)

  assert.equal(result.messages[0].content.length, 3)
  assert.deepEqual(result.messages[0].content[0], first)
  assert.equal(result.messages[0].content[1].type, 'text')
  assert.match(result.messages[0].content[1].text, /sha256:aaaa/u)
  assert.match(result.messages[0].content[1].text, /Read-only local copy/u)
  assert.deepEqual(result.messages[0].content[2], last)
  assert.equal(result.pending.length, 0)
  assert.equal(result.replaced, 1)
})

test('递归 tool-result：嵌套图片按路径 key 替换', () => {
  const env = makeEnv()
  const block = image()
  const nested = { type: 'tool-result', content: [{ type: 'text', text: 't' }, block] }
  const key = occurrenceKey('s1', { id: 'm1' }, '0.1', block)
  env.sent.add(key)

  const result = projectMessages([userMessage(nested)], env)
  const outer = result.messages[0].content[0]
  assert.equal(outer.type, 'tool-result')
  assert.equal(outer.content[0].type, 'text')
  assert.equal(outer.content[1].type, 'text')
  assert.match(outer.content[1].text, /sha256:aaaa/u)
})

test('minImages 阈值不足时只记账、不改写', () => {
  const env = makeEnv({ minImages: 2 })
  const block = image()
  env.sent.add(occurrenceKey('s1', { id: 'm1' }, '0', block))
  const result = projectMessages([userMessage(block)], env)
  assert.equal(result.messages[0].content[0], block)
  assert.equal(result.replaced, 0)
  assert.equal(result.pending.length, 0)
})

test('minImages 达到阈值后替换，pending 仍然收集首次出现', () => {
  const env = makeEnv({ minImages: 2 })
  const sentBlock = image('sha256:old')
  const freshBlock = image('sha256:new')
  env.sent.add(occurrenceKey('s1', { id: 'm1' }, '0', sentBlock))

  const result = projectMessages([userMessage(sentBlock, freshBlock)], env)
  assert.equal(result.replaced, 1)
  assert.equal(result.pending.length, 1)
  assert.equal(result.pending[0].ref.attachmentId, 'sha256:new')
  assert.equal(result.messages[0].content[0].type, 'text')
  assert.equal(result.messages[0].content[1].type, 'image')
})

test('offloaded 的块直接替换、不进入 pending', () => {
  const env = makeEnv({
    features: { caption: false, thumbnail: true },
    thumbFor: () => image('sha256:thumbnail').attachment,
    keepRecentTurns: 1,
  })
  const block = { ...image(), offloaded: true }
  const result = projectMessages([userMessage(block)], env)
  assert.equal(result.messages[0].content[0].type, 'text')
  assert.equal(result.pending.length, 0)
  assert.equal(result.replaced, 1)
})

test('重看路径不可用或后台信息未准备好时保留原图', () => {
  const block = image()
  const messages = [userMessage(block)]
  for (const override of [
    { pathFor: () => undefined, captionFor: () => '已有描述' },
    { waitForCaption: () => true },
    {
      features: { caption: true, thumbnail: true },
      thumbFor: () => image('sha256:thumbnail').attachment,
      waitForCaption: () => true,
    },
  ]) {
    const env = makeEnv({ features: { caption: true, thumbnail: false }, ...override })
    env.sent.add(occurrenceKey('s1', messages[0], '0', block))
    const result = projectMessages(messages, env)
    assert.equal(result.messages, messages)
    assert.equal(result.seen.size, 1)
  }
})

test('保留窗口涵盖最近用户轮里的工具结果图片', () => {
  const olderImage = image('older')
  const latestImage = image('latest')
  const older = { role: 'tool', id: 'tool-older', content: [olderImage] }
  const latest = { role: 'tool', id: 'tool-latest', content: [{ type: 'tool-result', content: [latestImage] }] }
  const messages = [
    userMessage({ type: 'text', text: 'previous question' }), older,
    { role: 'user', id: 'next', content: [{ type: 'text', text: 'current question' }] }, latest,
  ]
  const env = makeEnv({ keepRecentTurns: 1 })
  env.sent.add(occurrenceKey('s1', older, '0', olderImage))
  env.sent.add(occurrenceKey('s1', latest, '0.0', latestImage))
  const result = projectMessages(messages, env)
  assert.equal(result.messages[1].content[0].type, 'text')
  assert.equal(result.messages[3], latest)
})

test('无持久消息 id 的临时图片不会误用发送记录', () => {
  const env = makeEnv({ hasSent: () => true })
  const messages = [{ role: 'user', content: [image()] }]
  const result = projectMessages(messages, env)
  assert.equal(result.messages, messages)
  assert.equal(result.pending.length, 0)
})

test('描述命中时文本包含描述；关闭 caption 时不包含', () => {
  const block = image()
  const base = makeEnv()
  base.sent.add(occurrenceKey('s1', { id: 'm1' }, '0', block))

  const offloaded = { ...image(), offloaded: true }
  const withCaption = projectMessages(
    [userMessage(offloaded)],
    makeEnv({ features: { caption: true, thumbnail: false, minImages: 1 }, captionFor: () => '画面：一张报错截图' }),
  )
  assert.match(withCaption.messages[0].content[0].text, /报错截图/u)

  const without = projectMessages([userMessage(block)], base)
  assert.doesNotMatch(without.messages[0].content[0].text, /报错截图/u)
})

test('缩略图命中时输出 image + text，且 image 来自 thumbFor', () => {
  const block = image()
  const thumb = { attachmentId: 'sha256:thumb', mediaType: 'image/jpeg', bytes: 5, width: 320, height: 180 }
  const env = makeEnv({
    features: { caption: false, thumbnail: true, minImages: 1 },
    thumbFor: () => thumb,
  })
  env.sent.add(occurrenceKey('s1', { id: 'm1' }, '0', block))

  const result = projectMessages([userMessage(block)], env)
  assert.equal(result.messages[0].content[0].type, 'image')
  assert.equal(result.messages[0].content[0].attachment, thumb)
  assert.equal(result.messages[0].content[1].type, 'text')
})

test('无图消息返回原对象；hasImageDeep 覆盖嵌套', () => {
  const plain = { role: 'user', id: 'm2', content: [{ type: 'text', text: 'hi' }] }
  const result = projectMessages([plain], makeEnv())
  assert.equal(result.messages[0], plain)
  assert.equal(hasImageDeep([{ type: 'text', text: 'x' }]), false)
  assert.equal(hasImageDeep([{ type: 'tool-result', content: [image()] }]), true)
})

test('assistant 消息不参与改写', () => {
  const block = image()
  const env = makeEnv()
  env.sent.add(occurrenceKey('s1', { id: 'm1' }, '0', block))
  const assistant = { role: 'assistant', id: 'm1', content: [block] }
  const result = projectMessages([assistant], env)
  assert.equal(result.messages[0], assistant)
})
