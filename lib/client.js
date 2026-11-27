/**
 * dsh-image-reference —— 客户端设置卡片。
 *
 * 手写 bundle：平台闭包工厂形态 `window.__ModuleLoader__.load({ id, factory })`，
 * `factory(require) => exports`，不需要构建步骤。React 由平台 seed 提供。
 *
 * 挂载点：`plugins.row.config`，key = `dsh-image-reference#image-reference`。
 * 读写全部走 `props.form`（settings 服务），不自己开宿主路由、不直接碰 YAML。
 *
 * 配色契约：样式表只使用 DSH 自己的 `--dsw-*` / `--ds-font-family-code` token，
 * 不写任何颜色字面量。test/client.test.mjs 有一道白名单门禁。
 */

window.__ModuleLoader__.load({
  id: 'dsh-image-reference',
  factory: (require) => {
    const exports = {}
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-image-reference'
    const ROW_KEY = 'dsh-image-reference#image-reference'

    /** 卡片样式：只用平台 token，亮/暗主题各自成立。 */
    const CSS = [
      '.dir-card{display:flex;flex-direction:column;gap:12px;font-size:13px;color:var(--dsw-alias-label-primary)}',
      '.dir-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.dir-title{font-weight:600;font-size:14px}',
      '.dir-note{color:var(--dsw-alias-label-tertiary);line-height:1.5}',
      '.dir-error{color:var(--dsw-alias-state-error-primary);line-height:1.5}',
      '.dir-section{display:flex;flex-direction:column;gap:8px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:10px}',
      '.dir-section-title{font-weight:600}',
      '.dir-row{display:flex;align-items:center;gap:10px;min-height:28px}',
      '.dir-label{color:var(--dsw-alias-label-secondary);min-width:120px}',
      '.dir-hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.45}',
      '.dir-spacer{flex:1}',
      '.dir-input,.dir-select{box-sizing:border-box;flex:1;min-width:0;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);padding:4px 8px;font-size:12px}',
      '.dir-input:disabled,.dir-select:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}',
      '.dir-input:focus-visible,.dir-select:focus-visible,.dir-switch:focus-visible,.dir-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.dir-switch{box-sizing:border-box;flex:none;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3);cursor:pointer}',
      '.dir-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.dir-switch:disabled{opacity:.5;cursor:default}',
      '.dir-knob{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-switch-thumb);transition:transform .12s ease}',
      '.dir-switch[aria-checked="true"] .dir-knob{background:var(--dsw-alias-label-primary-foreground);transform:translateX(16px)}',
      '.dir-btn{border:0.5px solid var(--dsw-alias-border-l3);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);padding:3px 10px;font-size:12px;cursor:pointer}',
      '.dir-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dir-btn:disabled{opacity:.4;cursor:default}',
      '.dir-btn[data-danger="true"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '@media (prefers-reduced-motion:reduce){.dir-knob{transition:none}}',
    ].join('')

    let cssInjected = false
    function injectCss() {
      if (cssInjected || typeof document === 'undefined') return
      cssInjected = true
      const style = document.createElement('style')
      style.setAttribute('data-dsh-image-reference', '')
      style.textContent = CSS
      document.head.appendChild(style)
    }

    const zh = {
      title: '图片引用',
      summary: '保留近期图片，为历史图片使用描述或缩略图',
      features: '功能开关',
      caption: '文字描述',
      thumbnail: '小缩略图',
      minImages: '从第几张图开始接管',
      minImagesHint: '请求内未卸载的图片达到此数量时，开始替换符合条件的历史图。',
      keepRecentTurns: '保留原图的最近用户轮数',
      captionRoute: '描述模型',
      follow: '跟随当前模型',
      provider: 'Provider',
      model: '模型 id',
      modelHint: 'provider 与模型 id 都填才生效；留空 = 跟随当前请求。',
      preset: '描述预设',
      presetAuto: '自动识别',
      presetStandard: '标准预设',
      presetErrorScreenshot: '报错截图',
      style: '描述风格',
      styleStructured: '结构化（画面 / 文字 / 关键元素）',
      styleBrief: '一句话概况',
      styleOcr: 'OCR 优先（尽量转录可读文字）',
      language: '描述语言',
      langEn: '英文（更省 token）',
      langZh: '中文',
      langAuto: '跟随图片里的文字',
      stateSection: '记忆文件',
      persist: '保存记忆到磁盘',
      persistHint: '文件可能含截图文字。修改后重启 DSH 生效。如需清除现有记忆，请先执行清空。',
      stateScope: '保存位置',
      scopeProfile: '当前 profile 专属目录',
      scopeHome: '全局（所有 profile 共用）',
      statePath: '自定义路径',
      statePathHint: '留空 = 按上面的保存位置自动推导；改保存位置需要重启 DSH。',
      clear: '清空记忆',
      clearCaptions: '清除并按需重算描述',
      clearHint: '只重算描述时，已替换的历史图会先用仍可读的路径或缩略图。清空记忆会清除发送记录和全部缓存引用。',
      loading: '正在读取配置…',
      unavailable: '配置不可用（宿主未提供设置服务）。',
      readOnly: '当前部署只读，无法修改。',
      failed: '写入失败：{message}',
      notSupported: '当前 DSH 版本不受支持（本插件只兼容 0.2.x）。',
      saved: '已保存',
    }
    const en = {
      title: 'Image reference',
      summary: 'Keep recent images and use descriptions or thumbnails for older images',
      features: 'Features',
      caption: 'Text description',
      thumbnail: 'Small thumbnail',
      minImages: 'Take over from image #',
      minImagesHint: 'Replace eligible older images when the request contains at least this many retained images.',
      keepRecentTurns: 'Recent user turns that keep full images',
      captionRoute: 'Description model',
      follow: 'Follow current model',
      provider: 'Provider',
      model: 'Model id',
      modelHint: 'Both provider and model id are required; leave both empty to follow the current request.',
      preset: 'Description preset',
      presetAuto: 'Detect automatically',
      presetStandard: 'Standard',
      presetErrorScreenshot: 'Error screenshot',
      style: 'Description style',
      styleStructured: 'Structured (scene / text / key elements)',
      styleBrief: 'One-sentence summary',
      styleOcr: 'OCR first (transcribe readable text)',
      language: 'Description language',
      langEn: 'English (fewest tokens)',
      langZh: 'Chinese',
      langAuto: 'Follow the language in the image',
      stateSection: 'Memory file',
      persist: 'Save memory to disk',
      persistHint: 'The file may contain screenshot text. Restart DSH to apply changes. Clear existing memory first if needed.',
      stateScope: 'Location',
      scopeProfile: 'This profile only',
      scopeHome: 'Global (shared by all profiles)',
      statePath: 'Custom path',
      statePathHint: 'Empty = derive from the location above; changing the location requires a DSH restart.',
      clear: 'Clear memory',
      clearCaptions: 'Clear and rebuild descriptions on demand',
      clearHint: 'While descriptions rebuild, previously replaced images use a readable path or an existing thumbnail. Clearing memory removes sent records and all cache references.',
      loading: 'Reading configuration…',
      unavailable: 'Configuration is unavailable (no settings service in this deployment).',
      readOnly: 'This deployment is read-only, so settings cannot be changed.',
      failed: 'Write failed: {message}',
      notSupported: 'This DSH version is not supported (the plugin targets 0.2.x).',
      saved: 'Saved',
    }

    function objectOf(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
    }

    /** 读取 form 快照里的纯数据配置。 */
    function snapshotOf(form) {
      const state = form?.state
      const value = objectOf(state?.value)
      return {
        state,
        writable: state?.writable === true && typeof state?.revision === 'number',
        features: objectOf(value.features),
        caption: objectOf(value.caption),
        stateConfig: objectOf(value.state),
      }
    }

    /** 构建卡片组件。 */
    function makeCard(ctx) {
      return function ImageReferenceCard(props) {
        const t = typeof props.t === 'function' ? props.t : (key) => key
        const view = props.view
        const form = props.form
        const snap = snapshotOf(form)

        const [directory, setDirectory] = React.useState([])
        const [error, setError] = React.useState(null)
        const [busy, setBusy] = React.useState(false)
        const [minDraft, setMinDraft] = React.useState(null)
        const [modelDraft, setModelDraft] = React.useState(null)
        const [pathDraft, setPathDraft] = React.useState(null)

        React.useEffect(() => {
          let alive = true
          const llm = ctx?.remote?.llm
          if (llm === undefined || typeof llm.listProviders !== 'function') {
            setDirectory([])
            return () => { alive = false }
          }
          const declared = typeof llm.listConfigurableProviders === 'function'
            ? Promise.resolve(llm.listConfigurableProviders()).catch(() => ({ ok: false }))
            : Promise.resolve({ ok: false })
          Promise.all([Promise.resolve(llm.listProviders()).catch(() => ({ ok: false })), declared])
            .then(([registered, configurable]) => {
              if (!alive) return
              const rows = new Map()
              if (registered?.ok === true) {
                for (const entry of registered.value ?? []) {
                  const provider = String(entry.id)
                  rows.set(provider, { provider, label: entry.name || provider })
                }
              }
              if (configurable?.ok === true) {
                for (const entry of configurable.value ?? []) {
                  const provider = String(entry.provider)
                  if (!rows.has(provider)) rows.set(provider, { provider, label: entry.displayName || provider })
                }
              }
              setDirectory([...rows.values()])
            })
            .catch(() => { if (alive) setDirectory([]) })
          return () => { alive = false }
        }, [])

        if (view === 'summary') return h('span', { className: 'dir-note' }, t('summary'))
        if (snap.state === undefined) return h('div', { className: 'dir-card' }, h('div', { className: 'dir-note' }, t('unavailable')))
        if (snap.state.status === 'loading') return h('div', { className: 'dir-card' }, h('div', { className: 'dir-note' }, t('loading')))

        const { features, caption, stateConfig } = snap
        const writable = snap.writable

        const write = (ops) => {
          if (!writable || busy || ops.length === 0) return
          setBusy(true)
          setError(null)
          Promise.resolve(form.mutate(ops, snap.state.revision))
            .then((ok) => {
              if (ok === false) setError(t('failed', { message: 'rejected' }))
            })
            .catch((cause) => setError(t('failed', { message: cause?.message ?? String(cause) })))
            .then(() => setBusy(false))
        }
        const setField = (path, value) => write([{ op: 'set', path, value }])

        const switchRow = (path, label, value) => h(
          'div',
          { className: 'dir-row', key: path.join('.') },
          h('span', { className: 'dir-label' }, label),
          h('span', { className: 'dir-spacer' }),
          h(
            'button',
            {
              type: 'button',
              className: 'dir-switch',
              role: 'switch',
              'aria-checked': String(value === true),
              'aria-label': label,
              disabled: !writable || busy,
              onClick: () => setField(path, value !== true),
            },
            h('span', { className: 'dir-knob' }),
          ),
        )

        const minValue = minDraft ?? String(features.minImages ?? 1)
        const modelValue = modelDraft ?? String(caption.model ?? '')
        const pathValue = pathDraft ?? String(stateConfig.path ?? '')

        const providerOptions = [
          h('option', { key: '__follow', value: '' }, t('follow')),
          ...directory.map((row) => h('option', { key: row.provider, value: row.provider }, `${row.label}（${row.provider}）`)),
        ]
        const providerValue = String(caption.provider ?? '')
        if (providerValue.length > 0 && !directory.some((row) => row.provider === providerValue)) {
          providerOptions.push(h('option', { key: providerValue, value: providerValue }, providerValue))
        }

        return h(
          'div',
          { className: 'dir-card' },
          h('div', { className: 'dir-head' }, h('span', { className: 'dir-title' }, t('title')), h('span', { className: 'dir-spacer' }), error === null ? null : h('span', { className: 'dir-error' }, error)),
          writable ? null : h('div', { className: 'dir-note' }, t('readOnly')),

          h(
            'div',
            { className: 'dir-section' },
            h('div', { className: 'dir-section-title' }, t('features')),
            switchRow(['features', 'caption'], t('caption'), features.caption ?? true),
            switchRow(['features', 'thumbnail'], t('thumbnail'), features.thumbnail ?? true),
            h(
              'div',
              { className: 'dir-row' },
              h('span', { className: 'dir-label' }, t('minImages')),
              h('input', {
                className: 'dir-input',
                type: 'number',
                min: 1,
                max: 50,
                value: minValue,
                disabled: !writable || busy,
                onChange: (event) => setMinDraft(event.target.value),
                onBlur: () => {
                  const next = Number(minValue)
                  setMinDraft(null)
                  if (Number.isInteger(next) && next >= 1 && next <= 50 && next !== Number(features.minImages ?? 1)) {
                    setField(['features', 'minImages'], next)
                  }
                },
              }),
            ),
            h('div', { className: 'dir-hint' }, t('minImagesHint')),
            h('label', { className: 'dir-row' },
              h('span', { className: 'dir-label' }, t('keepRecentTurns')),
              h('select', {
                className: 'dir-select',
                value: String(features.keepRecentTurns ?? 1),
                disabled: !writable || busy,
                onChange: (event) => setField(['features', 'keepRecentTurns'], Number(event.target.value)),
              }, Array.from({ length: 11 }, (_, value) => h('option', { key: value, value }, String(value)))),
            ),
          ),

          h(
            'div',
            { className: 'dir-section' },
            h('div', { className: 'dir-section-title' }, t('captionRoute')),
            h('div', { className: 'dir-row' }, h('span', { className: 'dir-label' }, t('provider')), h('select', {
              className: 'dir-select',
              value: providerValue,
              disabled: !writable || busy,
              onChange: (event) => setField(['caption', 'provider'], event.target.value),
            }, providerOptions)),
            h('div', { className: 'dir-row' }, h('span', { className: 'dir-label' }, t('model')), h('input', {
              className: 'dir-input',
              type: 'text',
              value: modelValue,
              placeholder: 'deepseek-v4.1-flash',
              disabled: !writable || busy,
              onChange: (event) => setModelDraft(event.target.value),
              onBlur: () => {
                setModelDraft(null)
                if (modelValue !== String(caption.model ?? '')) setField(['caption', 'model'], modelValue)
              },
              onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
            })),
            h('div', { className: 'dir-hint' }, t('modelHint')),
            h('label', { className: 'dir-row' },
              h('span', { className: 'dir-label' }, t('preset')),
              h('select', {
                className: 'dir-select',
                value: String(caption.preset ?? 'auto'),
                disabled: !writable || busy,
                onChange: (event) => setField(['caption', 'preset'], event.target.value),
              },
              h('option', { value: 'auto' }, t('presetAuto')),
              h('option', { value: 'standard' }, t('presetStandard')),
              h('option', { value: 'error-screenshot' }, t('presetErrorScreenshot')),
              ),
            ),
            h('div', { className: 'dir-row' }, h('span', { className: 'dir-label' }, t('style')), h('select', {
              className: 'dir-select',
              value: String(caption.style ?? 'structured'),
              disabled: !writable || busy,
              onChange: (event) => setField(['caption', 'style'], event.target.value),
            },
            h('option', { value: 'structured' }, t('styleStructured')),
            h('option', { value: 'brief' }, t('styleBrief')),
            h('option', { value: 'ocr' }, t('styleOcr')),
            )),
            h('div', { className: 'dir-row' }, h('span', { className: 'dir-label' }, t('language')), h('select', {
              className: 'dir-select',
              value: String(caption.language ?? 'en'),
              disabled: !writable || busy,
              onChange: (event) => setField(['caption', 'language'], event.target.value),
            },
            h('option', { value: 'en' }, t('langEn')),
            h('option', { value: 'zh' }, t('langZh')),
            h('option', { value: 'auto' }, t('langAuto')),
            )),
          ),

          h(
            'div',
            { className: 'dir-section' },
            h('div', { className: 'dir-section-title' }, t('stateSection')),
            switchRow(['state', 'persist'], t('persist'), stateConfig.persist ?? true),
            h('div', { className: 'dir-hint' }, t('persistHint')),
            h('div', { className: 'dir-row' }, h('span', { className: 'dir-label' }, t('stateScope')), h('select', {
              className: 'dir-select',
              value: String(stateConfig.scope ?? 'profile'),
              disabled: !writable || busy,
              onChange: (event) => setField(['state', 'scope'], event.target.value),
            },
            h('option', { value: 'profile' }, t('scopeProfile')),
            h('option', { value: 'home' }, t('scopeHome')),
            )),
            h('div', { className: 'dir-row' }, h('span', { className: 'dir-label' }, t('statePath')), h('input', {
              className: 'dir-input',
              type: 'text',
              value: pathValue,
              placeholder: 'C:\\Users\\...\\image-reference\\state.json',
              disabled: !writable || busy,
              onChange: (event) => setPathDraft(event.target.value),
              onBlur: () => {
                setPathDraft(null)
                if (pathValue !== String(stateConfig.path ?? '')) setField(['state', 'path'], pathValue)
              },
              onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() },
            })),
            h('div', { className: 'dir-hint' }, t('statePathHint')),
            h('div', { className: 'dir-row' }, h('span', { className: 'dir-spacer' }), h('button', {
              type: 'button',
              className: 'dir-btn',
              'data-danger': 'true',
              disabled: !writable || busy,
              onClick: () => setField(['state', 'clearToken'], Date.now()),
            }, t('clear'))),
            h('div', { className: 'dir-row' }, h('span', { className: 'dir-spacer' }), h('button', {
              type: 'button',
              className: 'dir-btn',
              disabled: !writable || busy,
              onClick: () => setField(['state', 'clearCaptionsToken'], Date.now()),
            }, t('clearCaptions'))),
            h('div', { className: 'dir-hint' }, t('clearHint')),
          ),
        )
      }
    }

    const name = 'dsh-image-reference'
    const inject = ['slots', 'locale', 'remote', 'remote.llm']

    function apply(ctx) {
      injectCss()
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-image-reference: copy dictionaries')
      const Card = makeCard(ctx)
      ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: ROW_KEY, locale: NS }, Card))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = name
    return exports
  },
})
