import test from 'node:test'
import assert from 'node:assert/strict'

import { CapabilityCache } from '../lib/capabilities.js'

function makeLlm(result = { modalities: ['text', 'image'] }) {
  const state = { calls: 0 }
  return {
    state,
    async prepareCall() {
      state.calls += 1
      if (result.fail === true) throw new Error('no route')
      return { inputModalities: result.modalities }
    },
  }
}

test('查询前能力未知，查询后缓存 inputModalities', async () => {
  const llm = makeLlm()
  const cache = new CapabilityCache({ llm })
  assert.equal(cache.known('p', 'm'), undefined)
  assert.equal(await cache.ensure('p', 'm'), true)
  assert.equal(cache.known('p', 'm'), true)
  assert.equal(llm.state.calls, 1)
  assert.equal(await cache.ensure('p', 'm'), true)
  assert.equal(llm.state.calls, 1)
})

test('模型未声明图片能力时返回 false', async () => {
  const cache = new CapabilityCache({ llm: makeLlm({ modalities: ['text'] }) })
  assert.equal(await cache.ensure('p', 'm'), false)
  assert.equal(cache.known('p', 'm'), false)
})

test('inputModalities 缺失时保持未知', async () => {
  const cache = new CapabilityCache({ llm: makeLlm({ modalities: undefined }) })
  assert.equal(await cache.ensure('p', 'm'), false)
  assert.equal(cache.known('p', 'm'), undefined)
})

test('查询失败不抛，缓存未知能力', async () => {
  const cache = new CapabilityCache({ llm: makeLlm({ fail: true }) })
  assert.equal(await cache.ensure('p', 'm'), false)
  assert.equal(cache.known('p', 'm'), undefined)
})

test('并发查询同一路由只发一次', async () => {
  const llm = makeLlm()
  const cache = new CapabilityCache({ llm })
  const results = await Promise.all([cache.ensure('p', 'm'), cache.ensure('p', 'm')])
  assert.deepEqual(results, [true, true])
  assert.equal(llm.state.calls, 1)
})
