import assert from 'node:assert/strict'
import test from 'node:test'

import { captionSystemPrompt } from '../lib/caption.js'
import { readSettings } from '../lib/config.js'
import { parsePresetCaption } from '../lib/presets.js'

function options(caption = {}) {
  return readSettings({ caption }).caption
}

test('自动识别在同一个提示中提供两个预设，手动选择只提供指定预设', () => {
  const automatic = captionSystemPrompt(options())
  assert.match(automatic, /Choose "error-screenshot"/u)
  assert.match(automatic, /"visibleText"/u)
  assert.match(automatic, /"errorMessage"/u)
  const standard = captionSystemPrompt(options({ preset: 'standard' }))
  assert.match(standard, /Set preset to "standard"/u)
  assert.doesNotMatch(standard, /"errorMessage"/u)
  const error = captionSystemPrompt(options({ preset: 'error-screenshot' }))
  assert.match(error, /Set preset to "error-screenshot"/u)
  assert.doesNotMatch(error, /"visibleText"/u)
})

test('标准预设把类型、概况和可见文字分别保存', () => {
  const result = parsePresetCaption(JSON.stringify({
    preset: 'standard', imageType: '仪表盘', summary: '显示队列情况', visibleText: 'Pending 23',
    uncertain: '右下角数字太小',
  }), options({ language: 'zh' }))
  assert.deepEqual(result.data, {
    version: 1, preset: 'standard', imageType: '仪表盘', summary: '显示队列情况', visibleText: 'Pending 23',
    uncertain: '右下角数字太小',
  })
  assert.match(result.text, /可见文字: Pending 23/u)
})

test('报错预设保存错误原文、位置和代码，优先显示报错行', () => {
  const screenshot = JSON.stringify({
    preset: 'error-screenshot', errorMessage: 'TypeError: Cannot read properties of undefined',
    file: 'src/list.ts', line: 17, column: 4,
    code: [{ line: 16, text: 'const result = []' }, { line: 17, text: '  items.map(renderItem)' }],
    uncertain: 'Line 18 is cropped.',
  })
  const result = parsePresetCaption('\n```json\n' + screenshot + '\n```\n', options())
  assert.equal(result.data.errorMessage, 'TypeError: Cannot read properties of undefined')
  assert.equal(result.data.file, 'src/list.ts')
  assert.equal(result.data.line, 17)
  assert.equal(result.data.column, 4)
  assert.deepEqual(result.data.code[0], { line: 17, text: '  items.map(renderItem)' })
  assert.match(result.text, /Code 17 \| {3}items\.map\(renderItem\)/u)
  assert.ok(result.text.indexOf('Code 17') < result.text.indexOf('Code 16'))
})

test('不保存冲突行号、非法坐标或预算放不下的原文片段', () => {
  const result = parsePresetCaption(JSON.stringify({
    preset: 'error-screenshot', errorMessage: 'LONG_ERROR_'.repeat(30), line: 17, column: -3,
    code: [
      { line: 17, text: 'items.map(renderItem)' }, { line: 18, text: 'first' },
      { line: 18, text: 'conflicting' }, { line: 19, text: 'multi\nline' }, { line: null, text: 'return items' },
    ],
  }), options({ maxChars: 120 }))
  assert.ok(result.text.length <= 120)
  assert.equal(result.data.errorMessage, undefined)
  assert.equal(result.data.column, undefined)
  assert.deepEqual(result.data.code, [
    { line: 17, text: 'items.map(renderItem)' }, { line: null, text: 'return items' },
  ])
  assert.doesNotMatch(result.text, /LONG_ERROR|Code 18|Code 19/u)
})

test('非结构化回复可作说明，残缺 JSON 或预设不匹配不会存成有效结构', () => {
  assert.deepEqual(parsePresetCaption('A plain description', options()), { text: 'A plain description' })
  assert.throws(() => parsePresetCaption('{"preset":"error-screenshot"', options()), /invalid structured/u)
  assert.throws(() => parsePresetCaption('{"preset":"other"}', options()), /unexpected/u)
  assert.throws(() => parsePresetCaption('{"preset":"standard"}', options({ preset: 'error-screenshot' })), /unexpected/u)
})
