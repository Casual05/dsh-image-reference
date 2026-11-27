import { cleanCaption } from './text.js'

const PRESETS = ['standard', 'error-screenshot']

const STANDARD_FIELDS = [
  'For standard use imageType for a short category, summary for the subject and layout, visibleText for readable text, and uncertain for any important unreadable detail.',
  'Shape: {"preset":"standard","imageType":"...","summary":"...","visibleText":"...","uncertain":"..."}',
]
const ERROR_FIELDS = [
  'For error-screenshot copy the primary error verbatim in errorMessage, and record its file, line, and column only when visible and actually associated with the error.',
  'Use code for complete, readable code lines relevant to the error, prioritizing the reported line. Each entry is one line. Use null as its line number when the number is not visible. Preserve case, punctuation, and indentation. Do not reconstruct partly obscured lines; describe the missing area in uncertain.',
  'Shape: {"preset":"error-screenshot","errorMessage":"...","file":"...","line":null,"column":null,"code":[{"line":null,"text":"..."}],"uncertain":"...","summary":"..."}',
]

export function presetPrompt(cfg) {
  if (cfg.preset === 'standard') return ['Set preset to "standard".', ...STANDARD_FIELDS]
  if (cfg.preset === 'error-screenshot') return ['Set preset to "error-screenshot".', ...ERROR_FIELDS]
  return [
    'Choose "error-screenshot" when the image visibly shows a software error, failed test/build, stack trace, or editor diagnostic. Choose "standard" for other images, including code screenshots with no visible error or when the classification is unclear.',
    ...STANDARD_FIELDS,
    ...ERROR_FIELDS,
  ]
}

const LABELS = {
  en: {
    imageType: 'Image type', summary: 'Summary', visibleText: 'Visible text', errorMessage: 'Error',
    file: 'File', line: 'Error line', column: 'Error column', code: 'Code', uncertain: 'Unclear',
    omitted: 'Some fields omitted. Inspect the image for details.',
  },
  zh: {
    imageType: '图片类型', summary: '画面概况', visibleText: '可见文字', errorMessage: '错误原文',
    file: '文件', line: '报错行号', column: '报错列号', code: '可见代码', uncertain: '待核对',
    omitted: '部分字段已省略，细节请核对图片。',
  },
}

/** 验证预设字段，存结构化数据，并在字符预算内生成模型可读文本。 */
export function parsePresetCaption(raw, cfg) {
  const content = cleanCaption(raw.trim(), 0)
  if (!content.startsWith('{')) return { text: cleanCaption(content, cfg.maxChars) }

  let value
  try {
    value = JSON.parse(content)
  } catch {
    throw new Error('invalid structured image description')
  }
  if (!PRESETS.includes(value.preset) || (cfg.preset !== 'auto' && value.preset !== cfg.preset)) {
    throw new Error('unexpected image description preset')
  }

  const labels = cfg.language === 'zh' ? LABELS.zh : LABELS.en
  const data = { version: 1, preset: value.preset }
  const lines = []
  let usedChars = 0
  let omitted = false
  const separator = () => lines.length > 0 ? 1 : 0
  const remaining = () => cfg.maxChars - usedChars - separator()
  function append(line) {
    if (remaining() < line.length) {
      omitted = true
      return false
    }
    usedChars += line.length + separator()
    lines.push(line)
    return true
  }
  function addField(key, field, abbreviate = false) {
    if (field === undefined) return
    const label = `${labels[key]}: `
    const room = remaining() - label.length
    if (abbreviate && room > 1 && field.length > room) {
      field = field.slice(0, room - 1).trimEnd() + '…'
      omitted = true
    }
    if (append(label + field)) data[key] = field
  }

  if (value.preset === 'error-screenshot') {
    addField('errorMessage', readable(value.errorMessage))
    addField('file', readable(value.file))
    const line = positiveNumber(value.line)
    addField('line', line)
    addField('column', positiveNumber(value.column))
    const code = []
    for (const entry of readableCode(value.code, line)) {
      const label = entry.line === null ? labels.code : `${labels.code} ${entry.line}`
      if (append(`${label} | ${entry.text}`)) code.push(entry)
    }
    if (code.length > 0) data.code = code
    addField('uncertain', readable(value.uncertain), true)
    addField('summary', readable(value.summary), true)
  } else {
    addField('imageType', readable(value.imageType))
    addField('summary', readable(value.summary), true)
    addField('visibleText', readable(value.visibleText), true)
    addField('uncertain', readable(value.uncertain), true)
  }

  if (omitted && lines.length > 0) append(labels.omitted)
  return { text: lines.join('\n'), data }
}

function readable(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function positiveNumber(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

function readableCode(code, errorLine) {
  if (!Array.isArray(code)) return []
  const missingNumber = []
  const numbered = new Map()
  for (const entry of code) {
    const text = readable(entry?.text)
    if (text === undefined || /[\r\n]/u.test(text)) continue
    if (entry.line === null) {
      missingNumber.push({ line: null, text })
      continue
    }
    const line = positiveNumber(entry.line)
    if (line === undefined) continue
    // 同一个行号出现冲突的转录时，无法确认哪一条可以引用。
    if (!numbered.has(line)) numbered.set(line, text)
    else if (numbered.get(line) !== text) numbered.set(line, undefined)
  }
  const exact = [...numbered]
    .filter(([, text]) => text !== undefined)
    .map(([line, text]) => ({ line, text }))
    .sort((a, b) => Number(b.line === errorLine) - Number(a.line === errorLine) || a.line - b.line)
  return [...exact, ...missingNumber]
}
