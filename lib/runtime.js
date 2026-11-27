import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { appliesTo, captionKeyOf, legacyCaptionKeyOf, readSettings, resolveCaptionRoute, resolveStatePath, thumbKeyOf } from './config.js'
import { CapabilityCache } from './capabilities.js'
import { CaptionService } from './caption.js'
import { hasImageDeep, projectMessages } from './projection.js'
import { StateStore } from './state.js'
import { isSmallerThumbnail, ThumbnailService } from './thumbnail.js'

const WRAPPER = Symbol.for('dsh-image-reference.wrapper')
const IMAGE_ONCE_WRAPPER = Symbol.for('dsh-image-once.wrapper')
const SUCCESS = new Set(['stop', 'tool-calls', 'max-tokens'])

/** 宿主装配。DSH API 由入口注入，便于测试真正的包装和卸载流程。 */
export function installImageReference(ctx, config, { BlockAssembler, createUserMessage, resolveImageAttachmentAccess }) {
  const logger = ctx.logger
  const log = {
    info: (message) => logger?.info?.(`[image-reference] ${message}`),
    warn: (message) => logger?.warn?.(`[image-reference] ${message}`),
  }
  const settingsOf = () => readSettings(config)
  const initial = settingsOf()
  const state = new StateStore({
    ...initial.state,
    file: resolveStatePath(initial, {
      homeDir: process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
      profileDir: process.env.DSH_PROFILE_DIR,
      profileName: process.env.DSH_PROFILE,
    }),
    logger,
  })
  state.load()
  checkDshVersion(log)

  const capabilities = new CapabilityCache({ llm: ctx.llm })
  const captions = new CaptionService({
    llm: ctx.llm, createUserMessage, BlockAssembler, settings: settingsOf, state, logger,
    onModalities: (route, modalities) => capabilities.observe(route.provider, route.model, modalities),
  })
  const thumbs = new ThumbnailService({ attachments: ctx.attachments, settings: settingsOf, state, logger })
  const lastProjectionSummary = new Map()
  let generation = 0
  let disposed = false
  let lastClear = initial.state.clearToken
  let lastClearCaptions = initial.state.clearCaptionsToken
  ctx.on('loader/volatile-update', async () => {
    const { clearToken, clearCaptionsToken } = settingsOf().state
    const clearAll = clearToken > 0 && clearToken !== lastClear
    const clearCaptions = clearCaptionsToken > 0 && clearCaptionsToken !== lastClearCaptions
    lastClear = clearToken
    lastClearCaptions = clearCaptionsToken
    if (disposed || (!clearAll && !clearCaptions)) return
    generation += 1
    captions.reset()
    if (clearAll) {
      thumbs.reset()
      lastProjectionSummary.clear()
      await state.clearAll()
    } else {
      await state.clearCaches(['captions'])
    }
  })

  const registry = () => {
    const adapters = ctx.llm?.adapters
    return adapters instanceof Map ? adapters : undefined
  }
  const wrappers = new WeakMap()
  const installed = new Map()
  let conflictReported = false

  function localFile(hostPath, expectedBytes) {
    if (typeof hostPath !== 'string') return false
    const stat = fs.statSync(hostPath, { throwIfNoEntry: false })
    return stat?.isFile() === true && (expectedBytes === undefined || stat.size === expectedBytes)
  }

  function pathFor(ref) {
    try {
      const access = resolveImageAttachmentAccess(ctx.attachments, (hostPath) => {
        const processPath = ctx.get('fs')?.processPathFromHostPath(hostPath)
        return processPath && localFile(hostPath, ref.bytes) ? processPath : undefined
      }, ref)
      return access?.readonlyPath
    } catch {
      return undefined
    }
  }

  function thumbFor(ref, cfg) {
    const key = thumbKeyOf(ref.attachmentId, cfg)
    const thumb = state.getThumb(key)
    if (!isSmallerThumbnail(thumb, ref, cfg)) return undefined
    try {
      const hostPath = ctx.attachments?.imageHostPath?.(thumb)
      if (localFile(hostPath, thumb.bytes)) return thumb
    } catch {
      // 路径失效或无法验证时本次不用该引用。
    }
    state.forgetThumb(key)
    return undefined
  }

  function thumbnailWorthTrying(ref, cfg) {
    return Math.max(ref.width, ref.height) > cfg.longEdge && ref.bytes > 0
  }

  function commit(planned, options, policy, supportsImage) {
    const settings = settingsOf()
    const confirmed = supportsImage === true ? planned.pending : []
    state.markSent(confirmed.map(({ key }) => key))
    for (const [key, form] of planned.forms) state.putForm(key, policy, form)

    const captionRoute = resolveCaptionRoute(settings, options.provider, options.model)
    const captionSupport = capabilities.known(captionRoute.provider, captionRoute.model)
    const refs = new Map(planned.seen)
    for (const { key, ref } of confirmed) refs.set(key, ref)
    const uniqueRefs = new Set()
    const imageAllowed = supportsImage ?? capabilities.known(options.provider, options.model)
    for (const ref of refs.values()) {
      if (!ref?.attachmentId || uniqueRefs.has(ref.attachmentId)) continue
      uniqueRefs.add(ref.attachmentId)
      if (settings.features.caption) {
        captions.enqueue({
          ref, provider: options.provider, model: options.model, sessionId: options.sessionId,
          supportsImage: captionSupport,
        })
      }
      if (settings.features.thumbnail && imageAllowed === true && thumbnailWorthTrying(ref, settings.thumbnail)) {
        thumbs.enqueue({ ref })
      }
    }
    if (settings.log === 'verbose') {
      log.info(`本次替换 ${planned.replaced} 个图片块，成功记账 ${confirmed.length} 个首次图片块`)
    }
  }

  function reportProjection(options, level, { waiting, paths }) {
    if (level === 'off') return
    const key = JSON.stringify([String(options.sessionId), options.provider, options.model])
    if (waiting === 0 && paths === 0) {
      lastProjectionSummary.delete(key)
      return
    }
    const summary = `历史图片：${waiting} 张等待描述或缩略图而保留原图，${paths} 张使用本地路径引用`
    if (level !== 'verbose' && lastProjectionSummary.get(key) === summary) return
    if (!lastProjectionSummary.has(key) && lastProjectionSummary.size >= 128) {
      lastProjectionSummary.delete(lastProjectionSummary.keys().next().value)
    }
    lastProjectionSummary.set(key, summary)
    log.info(summary)
  }

  function dispatch(streamOf, options, preparedSupportsImage) {
    if (disposed || conflictReported || !options || options.purpose !== undefined) return streamOf(options)
    let settings
    try {
      settings = settingsOf()
      if (!appliesTo(settings, options.provider, options.model)) return streamOf(options)
      if (!Array.isArray(options.messages) || !options.messages.some((message) => hasImageDeep(message?.content))) {
        return streamOf(options)
      }
    } catch (error) {
      log.warn(`识别图片请求失败，按原样发送：${error?.message ?? error}`)
      return streamOf(options)
    }
    return dispatchWrapped(streamOf, options, settings, preparedSupportsImage)
  }

  async function* dispatchWrapped(streamOf, options, settings, preparedSupportsImage) {
    let planned
    let supportsImage
    let policy
    const startedIn = generation
    try {
      const { provider, model } = options
      supportsImage = preparedSupportsImage ?? capabilities.known(provider, model)
      const captionRoute = resolveCaptionRoute(settings, provider, model)
      const canDescribe = settings.features.caption && capabilities.known(captionRoute.provider, captionRoute.model) !== false
      const policyKey = (captionKey) => JSON.stringify([
        provider, model, settings.features.caption, settings.features.thumbnail,
        captionKey, thumbKeyOf('', settings.thumbnail),
      ])
      policy = policyKey(captionKeyOf('', settings.caption, captionRoute))
      const useLegacyCaption = settings.caption.preset === 'auto' && !settings.caption.prompt.trim()
      const legacyPolicy = useLegacyCaption ? policyKey(legacyCaptionKeyOf('', settings.caption, captionRoute)) : undefined
      const captionsForRequest = new Map()
      const captionKeys = new Map()
      const thumbsForRequest = new Map()
      const pathsForRequest = new Map()
      const captionKey = (ref) => memoized(captionKeys, ref, () => captionKeyOf(ref.attachmentId, settings.caption, captionRoute))
      planned = projectMessages(options.messages, {
        sessionId: options.sessionId,
        hasSent: (key) => state.isSent(key),
        minImages: settings.features.minImages,
        keepRecentTurns: settings.features.keepRecentTurns,
        features: settings.features,
        captionFor: (ref) => memoized(captionsForRequest, ref, () => {
          const caption = state.getCaptionText(captionKey(ref))
          if (caption !== undefined || !useLegacyCaption) return caption
          return state.getCaptionText(legacyCaptionKeyOf(ref.attachmentId, settings.caption, captionRoute))
        }),
        thumbFor: (ref) => memoized(thumbsForRequest, ref, () => thumbFor(ref, settings.thumbnail)),
        supportsImage: supportsImage === true,
        pathFor: (ref) => memoized(pathsForRequest, ref, () => pathFor(ref)),
        formFor: (key) => state.getForm(key, policy)
          ?? (legacyPolicy === undefined ? undefined : state.getForm(key, legacyPolicy)),
        waitForCaption: (ref) => canDescribe && !state.hasFailure(captionKey(ref)),
        waitForThumbnail: (ref) => settings.features.thumbnail && supportsImage === true
          && thumbnailWorthTrying(ref, settings.thumbnail)
          && !state.hasFailure(`thumb:${thumbKeyOf(ref.attachmentId, settings.thumbnail)}`),
        language: settings.caption.language,
      })
      if (supportsImage === undefined && (planned.pending.length > 0 || settings.features.thumbnail)) {
        void capabilities.ensure(provider, model)
      }
      reportProjection(options, settings.log, planned)
    } catch (error) {
      log.warn(`请求投影失败，按原样发送：${error?.message ?? error}`)
      yield* streamOf(options)
      return
    }

    const projected = planned.messages === options.messages ? options : { ...options, messages: planned.messages }
    let finish
    for await (const chunk of streamOf(projected)) {
      if (chunk?.type === 'finish') finish = chunk.reason
      yield chunk
    }
    if (disposed || conflictReported || startedIn !== generation || options.signal?.aborted || !SUCCESS.has(finish?.kind)) return
    try {
      commit(planned, options, policy, supportsImage)
    } catch (error) {
      log.warn(`记账失败：${error?.message ?? error}`)
    }
  }

  function wrapAdapter(inner) {
    return new Proxy(inner, {
      get(target, property) {
        if (property === WRAPPER) return true
        if (property === 'stream' && typeof target.stream === 'function') {
          return (options) => dispatch((next) => target.stream(next), options)
        }
        if (property === 'prepareCall' && typeof target.prepareCall === 'function') {
          return async (provider, model, signal) => {
            const call = await target.prepareCall(provider, model, signal)
            const supportsImage = disposed ? undefined : capabilities.observe(provider, model, call.model?.inputModalities)
            return { ...call, stream: (options) => dispatch((next) => call.stream(next), options, supportsImage) }
          }
        }
        const value = Reflect.get(target, property, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  }

  function restoreAdapters(adapters) {
    for (const [provider, slot] of installed) {
      const registration = adapters?.get(provider)
      if (registration?.adapter === slot.wrapper) {
        adapters.set(provider, { ...registration, adapter: slot.original })
      }
    }
    installed.clear()
  }

  function imageOnceEnabled() {
    try {
      const entries = ctx.get('loader')?.entries?.() ?? []
      for (const entry of entries) {
        const name = entry.options?.name
        if (typeof name === 'string' && /(^|\/)dsh-image-once(\/|$)/u.test(name.replaceAll('\\', '/'))
          && entry.disabled !== true && entry.options.disabled !== true) return true
      }
    } catch (error) {
      log.warn(`无法检查插件冲突：${error?.message ?? error}`)
    }
    return false
  }

  function installAll() {
    if (disposed) return
    const adapters = registry()
    if (adapters === undefined) {
      log.warn('无法访问适配器注册表，图片请求按原样发送')
      return
    }
    if (imageOnceEnabled() || [...adapters.values()].some((entry) => entry?.adapter?.[IMAGE_ONCE_WRAPPER])) {
      restoreAdapters(adapters)
      if (!conflictReported) {
        generation += 1
        captions.reset()
        thumbs.reset()
        log.warn('检测到 dsh-image-once，暂停图片引用改写')
      }
      conflictReported = true
      return
    }
    conflictReported = false
    for (const provider of installed.keys()) {
      if (!adapters.has(provider)) installed.delete(provider)
    }
    for (const [provider, registration] of adapters) {
      const original = registration?.adapter
      if (!original || original[WRAPPER]) continue
      if (installed.has(provider)) {
        capabilities.clear()
        log.info(`检测到 provider "${provider}" 的 adapter 已重挂`)
      }
      let wrapper = wrappers.get(original)
      if (wrapper === undefined) {
        wrapper = wrapAdapter(original)
        wrappers.set(original, wrapper)
      }
      adapters.set(provider, { ...registration, adapter: wrapper })
      installed.set(provider, { original, wrapper })
    }
  }

  const refreshAdapters = () => {
    try {
      installAll()
    } catch (error) {
      log.warn(`包裹 adapter 失败：${error?.message ?? error}`)
    }
  }
  refreshAdapters()
  ctx.on('llm/adapters-updated', refreshAdapters)
  ctx.on('loader/config-update', refreshAdapters)
  ctx.effect(() => async () => {
    disposed = true
    capabilities.stop()
    captions.stop()
    thumbs.stop()
    try {
      restoreAdapters(registry())
    } finally {
      await state.close()
    }
  }, 'dsh-image-reference: adapter wrapper + background queues')

  if (initial.log !== 'off') log.info(`已启用，已包裹 ${installed.size} 个 provider`)
}

function memoized(cache, ref, lookup) {
  if (!cache.has(ref.attachmentId)) cache.set(ref.attachmentId, lookup())
  return cache.get(ref.attachmentId)
}

function checkDshVersion(log) {
  try {
    const installDir = process.env.DSH_INSTALL_DIR
    if (installDir === undefined) return
    const { version } = JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8'))
    if (typeof version === 'string' && !/^0\.2\./u.test(version)) {
      log.warn(`当前 DSH 版本 ${version} 不在支持范围（0.2.x）`)
    }
  } catch {
    // 版本自检失败不影响会话。
  }
}
