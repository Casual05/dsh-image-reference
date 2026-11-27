import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import {
  appliesTo,
  captionKeyOf,
  captionMaxTokens,
  readSettings,
  resolveCaptionRoute,
  resolveStatePath,
  thumbKeyOf,
} from '../lib/config.js'

test('readSettings: 缺失配置全部落到默认值', () => {
  const settings = readSettings(undefined)
  assert.equal(settings.features.caption, true)
  assert.equal(settings.features.thumbnail, true)
  assert.equal(settings.features.minImages, 1)
  assert.deepEqual(settings.providers, {})
  assert.equal(settings.caption.preset, 'auto')
  assert.equal(settings.caption.style, 'structured')
  assert.equal(settings.caption.language, 'en')
  assert.equal(settings.caption.maxChars, 400)
  assert.equal(settings.thumbnail.longEdge, 320)
  assert.equal(settings.state.scope, 'profile')
  assert.equal(settings.state.persist, true)
  assert.equal(settings.log, 'summary')
})

test('readSettings: 普通对象覆盖 + 坏数字防呆', () => {
  const settings = readSettings({
    features: { caption: false, thumbnail: false, minImages: 3 },
    caption: { style: 'ocr', language: 'zh', maxChars: 0, concurrency: -2 },
    state: { scope: 'home' },
    log: 'verbose',
  })
  assert.equal(settings.features.caption, false)
  assert.equal(settings.features.minImages, 3)
  assert.equal(settings.caption.style, 'ocr')
  assert.equal(settings.caption.language, 'zh')
  assert.equal(settings.caption.maxChars, 400)
  assert.equal(settings.caption.concurrency, 2)
  assert.equal(settings.state.scope, 'home')
  assert.equal(settings.log, 'verbose')
})

test('readSettings: 接受 volatile 形态（get 对象）', () => {
  const features = {
    get: () => ({ caption: false, minImages: 5 }),
    [Symbol.for('cosmokit.volatile.write')]: true,
  }
  const settings = readSettings({ features })
  assert.equal(settings.features.caption, false)
  assert.equal(settings.features.minImages, 5)
})

test('appliesTo: 未出现的 provider 生效，关闭与模型白名单正确', () => {
  const settings = readSettings({
    providers: {
      opencode: { enabled: true, models: ['a'] },
      workbuddy: { enabled: false, models: [] },
    },
  })
  assert.equal(appliesTo(settings, 'deepseek', 'x'), true)
  assert.equal(appliesTo(settings, 'opencode', 'a'), true)
  assert.equal(appliesTo(settings, 'opencode', 'b'), false)
  assert.equal(appliesTo(settings, 'workbuddy', 'a'), false)
})

test('描述缓存区分路由和生成参数，缩略图缓存区分尺寸', () => {
  const settings = readSettings({})
  const route = { provider: 'p', model: 'vision' }
  const base = captionKeyOf('sha256:x', settings.caption, route)
  assert.notEqual(base, captionKeyOf('sha256:x', { ...settings.caption, style: 'brief' }, route))
  assert.notEqual(base, captionKeyOf('sha256:x', { ...settings.caption, language: 'zh' }, route))
  assert.notEqual(base, captionKeyOf('sha256:x', { ...settings.caption, prompt: 'CUSTOM PROMPT' }, route))
  assert.notEqual(base, captionKeyOf('sha256:x', { ...settings.caption, preset: 'standard' }, route))
  assert.notEqual(base, captionKeyOf('sha256:x', { ...settings.caption, preset: 'error-screenshot' }, route))
  assert.notEqual(base, captionKeyOf('sha256:x', settings.caption, { ...route, model: 'vision-v2' }))
  assert.notEqual(base, captionKeyOf('sha256:x', settings.caption, { ...route, provider: 'p2' }))
  assert.equal(base, captionKeyOf('sha256:x', settings.caption, route))

  const thumb = thumbKeyOf('sha256:x', settings.thumbnail)
  assert.notEqual(thumb, thumbKeyOf('sha256:x', { ...settings.thumbnail, longEdge: 480 }))
  assert.equal(thumb, thumbKeyOf('sha256:x', settings.thumbnail))
})

test('resolveStatePath: profile 默认、home 可切、显式 path 覆盖', () => {
  const profileDir = path.join('C:', 'tmp', 'profile')
  const homeDir = path.join('C:', 'tmp', 'home')
  const settings = readSettings({})
  assert.equal(
    resolveStatePath(settings, { profileDir, homeDir }),
    path.join(profileDir, 'image-reference', 'state.json'),
  )
  const home = readSettings({ state: { scope: 'home' } })
  assert.equal(
    resolveStatePath(home, { profileDir, homeDir }),
    path.join(homeDir, 'image-reference', 'state.json'),
  )
  const explicit = readSettings({ state: { path: path.join('C:', 'tmp', 'x.json') } })
  assert.equal(resolveStatePath(explicit, { profileDir, homeDir }), path.join('C:', 'tmp', 'x.json'))
})

test('resolveCaptionRoute: 跟随、指定、半指定回退', () => {
  const follow = readSettings({})
  assert.deepEqual(resolveCaptionRoute(follow, 'p', 'm'), { provider: 'p', model: 'm', warning: null })

  const fixed = readSettings({ caption: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  assert.deepEqual(resolveCaptionRoute(fixed, 'p', 'm'), {
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    warning: null,
  })

  const half = readSettings({ caption: { provider: 'deepseek-official' } })
  const halfRoute = resolveCaptionRoute(half, 'p', 'm')
  assert.equal(halfRoute.provider, 'p')
  assert.equal(halfRoute.model, 'm')
  assert.match(halfRoute.warning, /同时填写/u)
})

test('captionMaxTokens: 0 时按 maxChars 自动推算，显式值优先', () => {
  assert.equal(captionMaxTokens({ maxChars: 100, maxTokens: 0 }), 256)
  assert.equal(captionMaxTokens({ maxChars: 400, maxTokens: 0 }), 800)
  assert.equal(captionMaxTokens({ maxChars: 2000, maxTokens: 0 }), 1024)
  assert.equal(captionMaxTokens({ maxChars: 400, maxTokens: 300 }), 300)
})
