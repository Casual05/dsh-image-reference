import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const clientPath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const source = fs.readFileSync(clientPath, 'utf8')

/** image-once 的客户端 token 白名单；新增 token 前先确认它由 DSH theme 定义。 */
const TOKEN_ALLOWLIST = new Set([
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-brand-primary',
  '--dsw-alias-switch-thumb',
  '--dsw-alias-label-primary-foreground',
  '--dsw-radius-sm',
  '--dsw-radius-md',
  '--dsw-focus-ring-width',
  '--dsw-focus-ring-color',
  '--ds-font-family-code',
])

test('bundle 使用平台闭包工厂与正确的注册 key', () => {
  assert.match(source, /window\.__ModuleLoader__\.load\(/u)
  assert.match(source, /dsh-image-reference#image-reference/u)
  assert.match(source, /plugins\.row\.config/u)
})

test('CSS 只使用白名单 token，且没有颜色字面量', () => {
  const cssStart = source.indexOf('const CSS = [')
  const cssEnd = source.indexOf("].join('')", cssStart)
  assert.ok(cssStart >= 0 && cssEnd > cssStart, '找不到 CSS 块')
  const css = source.slice(cssStart, cssEnd)

  const tokens = [...css.matchAll(/var\((--[a-zA-Z0-9-]+)/gu)].map((match) => match[1])
  for (const token of tokens) {
    assert.equal(TOKEN_ALLOWLIST.has(token), true, `未登记的 CSS token: ${token}`)
  }

  assert.doesNotMatch(css, /#[0-9a-fA-F]{3,8}\b/u, 'CSS 不应出现十六进制颜色')
  assert.doesNotMatch(css, /\brgba?\(/u, 'CSS 不应出现 rgb()/rgba()')
  assert.doesNotMatch(css, /\bhsla?\(/u, 'CSS 不应出现 hsl()/hsla()')
})

test('zh / en 字典键对齐', () => {
  const zhStart = source.indexOf('const zh = {')
  const enStart = source.indexOf('const en = {')
  const zhEnd = source.indexOf('\n    }', zhStart)
  const enEnd = source.indexOf('\n    }', enStart)
  assert.ok(zhStart >= 0 && enStart > zhStart && zhEnd > zhStart && enEnd > enStart)

  const keysOf = (block) => [...block.matchAll(/^\s{6}([A-Za-z0-9_]+):/gmu)].map((match) => match[1]).sort()
  const zhKeys = keysOf(source.slice(zhStart, zhEnd))
  const enKeys = keysOf(source.slice(enStart, enEnd))

  assert.ok(zhKeys.length > 10, 'zh 字典键太少')
  assert.deepEqual(zhKeys, enKeys)
})

test('bundle 能在最小 React / 窗口环境下加载并注册卡片', () => {
  let definition
  const context = {
    window: {
      __ModuleLoader__: {
        load: (value) => { definition = value },
      },
    },
    console,
    Symbol,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Math,
    Date,
    JSON,
    Promise,
    Error,
    RegExp,
    Map,
    Set,
    setTimeout,
    clearTimeout,
  }
  vm.createContext(context)
  vm.runInContext(source, context)

  assert.ok(definition, 'bundle 没有调用 __ModuleLoader__.load')
  assert.equal(definition.id, 'dsh-image-reference')

  const fakeReact = {
    createElement: (...args) => ({ args }),
    useState: (initial) => [initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const api = definition.factory((id) => {
    if (id === 'react') return fakeReact
    throw new Error(`unexpected require: ${id}`)
  })

  assert.equal(api.name, 'dsh-image-reference')
  assert.deepEqual([...api.inject], ['slots', 'locale', 'remote', 'remote.llm'])
  assert.equal(typeof api.apply, 'function')

  let slot = null
  const fakeCtx = {
    effect: (fn) => fn(),
    locale: { register: () => {} },
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, component) => { slot = { options, component } },
    },
    remote: {},
  }
  api.apply(fakeCtx)

  assert.ok(slot, '没有注册 plugins.row.config 槽')
  assert.equal(slot.options.name, 'plugins.row.config')
  assert.equal(slot.options.key, 'dsh-image-reference#image-reference')
  assert.equal(slot.options.locale, 'dsh-image-reference')
  assert.equal(typeof slot.component, 'function')

  // 渲染 summary 视图（不涉及 hooks 的组件只在 props 齐全时使用。
  // React hooks 在这里是假的，只验证组件函数能返回元素）。
  const element = slot.component({ view: 'summary', t: (key) => key })
  assert.ok(element !== undefined)

  const writes = []
  const edit = slot.component({
    view: 'config',
    t: (key) => key,
    form: {
      state: { writable: true, revision: 19, value: {} },
      mutate: (ops, rev) => { writes.push({ rev, ops: JSON.parse(JSON.stringify(ops)) }); return true },
    },
  })
  function* elements(node) {
    if (Array.isArray(node)) {
      for (const child of node) yield* elements(child)
    } else if (node?.args !== undefined) {
      yield node.args
      yield* elements(node.args.slice(2))
    }
  }
  const actions = [...elements(edit)]
  const persist = actions.find(([kind, props]) => kind === 'button' && props['aria-label'] === 'persist')
  const rebuild = actions.find(([kind, _props, label]) => kind === 'button' && label === 'clearCaptions')
  const preset = actions.find(([kind, _props, ...choices]) => kind === 'select'
    && choices.some((choice) => choice?.args?.[2] === 'presetErrorScreenshot'))
  assert.equal(preset[1].value, 'auto')
  assert.equal(persist[1]['aria-checked'], 'true')
  persist[1].onClick()
  rebuild[1].onClick()
  preset[1].onChange({ target: { value: 'error-screenshot' } })
  assert.deepEqual(writes[0], { rev: 19, ops: [{ op: 'set', path: ['state', 'persist'], value: false }] })
  assert.deepEqual(writes[1].ops[0].path, ['state', 'clearCaptionsToken'])
  assert.equal(typeof writes[1].ops[0].value, 'number')
  assert.deepEqual(writes[2].ops, [{ op: 'set', path: ['caption', 'preset'], value: 'error-screenshot' }])
})
