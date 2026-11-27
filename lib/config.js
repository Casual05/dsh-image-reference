/**
 * dsh-image-reference —— 纯配置工具。
 *
 * 这个文件故意不 import 任何 DSH 包，因此可以在没有
 * DSH 运行时的单测里直接加载。schemastery 的 schema 在 schema.js。
 *
 * 配置读取原则：每次请求/每个后台任务现读，不缓存解析结果——这样设置页改完
 * 即时生效，和 dsh-image-once 的行为一致。schemastery 的 volatile 字段是
 * 「引用 + .get()」形态（cosmokit createVolatile），所以这里先 unwrap 再合并。
 */

import path from 'node:path'
import { createHash } from 'node:crypto'

/** features 的默认值。 */
export const DEFAULT_FEATURES = Object.freeze({
  caption: true,
  thumbnail: true,
  /** 接管阈值：当前请求里未 offloaded 的图片出现数达到该值才替换。 */
  minImages: 1,
  keepRecentTurns: 1,
})

/** caption 的默认值。 */
export const DEFAULT_CAPTION = Object.freeze({
  provider: '',
  model: '',
  preset: 'auto',
  style: 'structured',
  language: 'en',
  maxChars: 400,
  maxTokens: 0,
  concurrency: 2,
  timeoutMs: 60_000,
  retries: 1,
  cooldownMs: 600_000,
  maxQueue: 200,
  prompt: '',
})

/** thumbnail 的默认值。 */
export const DEFAULT_THUMBNAIL = Object.freeze({
  longEdge: 320,
  maxBytes: 65_536,
  concurrency: 1,
  maxQueue: 200,
  cooldownMs: 600_000,
})

/** state 的默认值。 */
export const DEFAULT_STATE = Object.freeze({
  persist: true,
  scope: 'profile',
  path: '',
  clearToken: 0,
  clearCaptionsToken: 0,
  maxOccurrences: 20_000,
  maxEntries: 10_000,
})

/** 日志级别默认值。 */
export const DEFAULT_LOG = 'summary'

/**
 * 拆开 schemastery 的 volatile 引用。
 * @param {unknown} value - 可能是 volatile、普通对象或 primitive。
 * @returns {unknown} 当前值；volatile 读取失败时返回 undefined。
 */
export function unwrap(value) {
  if (value === null || typeof value !== 'object') return value
  if (Symbol.for('cosmokit.volatile.write') in value) {
    try {
      return value.get()
    } catch {
      return undefined
    }
  }
  return value
}

/** 把一个值收敛成普通对象；数组与 null 都视为缺失。 */
function objectOf(value) {
  const raw = unwrap(value)
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
}

/**
 * 把 apply(ctx, config) 收到的配置解析成普通对象。
 * 缺失字段一律落到默认值，绝不让坏配置变成 undefined 访问。
 * @param {unknown} raw - schemastery 解析后的 config，或 undefined。
 * @returns {{
 *   features: typeof DEFAULT_FEATURES,
 *   providers: Record<string, { enabled: boolean, models: string[] }>,
 *   caption: typeof DEFAULT_CAPTION,
 *   thumbnail: typeof DEFAULT_THUMBNAIL,
 *   state: typeof DEFAULT_STATE,
 *   log: string,
 * }}
 */
export function readSettings(raw) {
  const root = raw !== null && typeof raw === 'object' ? raw : {}
  const features = { ...DEFAULT_FEATURES, ...objectOf(root.features) }
  const caption = { ...DEFAULT_CAPTION, ...objectOf(root.caption) }
  const thumbnail = { ...DEFAULT_THUMBNAIL, ...objectOf(root.thumbnail) }
  const state = { ...DEFAULT_STATE, ...objectOf(root.state) }
  const providers = objectOf(root.providers)
  const log = unwrap(root.log)

  // 数字字段防呆：坏值（NaN/负值/字符串）回落到默认值。
  features.minImages = positiveInteger(features.minImages, DEFAULT_FEATURES.minImages)
  features.keepRecentTurns = nonNegativeInteger(features.keepRecentTurns, DEFAULT_FEATURES.keepRecentTurns)
  if (!['auto', 'standard', 'error-screenshot'].includes(caption.preset)) caption.preset = DEFAULT_CAPTION.preset
  caption.maxChars = positiveInteger(caption.maxChars, DEFAULT_CAPTION.maxChars)
  caption.maxTokens = nonNegativeInteger(caption.maxTokens, DEFAULT_CAPTION.maxTokens)
  caption.concurrency = positiveInteger(caption.concurrency, DEFAULT_CAPTION.concurrency)
  caption.timeoutMs = positiveInteger(caption.timeoutMs, DEFAULT_CAPTION.timeoutMs)
  caption.retries = nonNegativeInteger(caption.retries, DEFAULT_CAPTION.retries)
  caption.cooldownMs = nonNegativeInteger(caption.cooldownMs, DEFAULT_CAPTION.cooldownMs)
  caption.maxQueue = positiveInteger(caption.maxQueue, DEFAULT_CAPTION.maxQueue)
  thumbnail.longEdge = positiveInteger(thumbnail.longEdge, DEFAULT_THUMBNAIL.longEdge)
  thumbnail.maxBytes = positiveInteger(thumbnail.maxBytes, DEFAULT_THUMBNAIL.maxBytes)
  thumbnail.concurrency = positiveInteger(thumbnail.concurrency, DEFAULT_THUMBNAIL.concurrency)
  thumbnail.maxQueue = positiveInteger(thumbnail.maxQueue, DEFAULT_THUMBNAIL.maxQueue)
  thumbnail.cooldownMs = nonNegativeInteger(thumbnail.cooldownMs, DEFAULT_THUMBNAIL.cooldownMs)
  state.maxOccurrences = positiveInteger(state.maxOccurrences, DEFAULT_STATE.maxOccurrences)
  state.maxEntries = positiveInteger(state.maxEntries, DEFAULT_STATE.maxEntries)

  return {
    features,
    providers,
    caption,
    thumbnail,
    state,
    log: typeof log === 'string' ? log : DEFAULT_LOG,
  }
}

function positiveInteger(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function nonNegativeInteger(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

/**
 * 这个 provider/model 是否进本插件。
 * 语义与 dsh-image-once 一致：没出现过的 provider = 生效；models 为空 = 全部模型。
 * @param {ReturnType<typeof readSettings>} settings
 * @param {string} provider - 适配器注册名。
 * @param {string} model - 模型 id。
 * @returns {boolean}
 */
export function appliesTo(settings, provider, model) {
  const entry = settings.providers[provider]
  if (entry === null || typeof entry !== 'object') return true
  if (entry.enabled === false) return false
  const models = Array.isArray(entry.models) ? entry.models : []
  if (models.length > 0 && !models.map(String).includes(String(model))) return false
  return true
}

/**
 * 描述缓存键包含实际路由和输出参数；自定义提示词只保存摘要。
 * @param {string} attachmentId
 * @param {ReturnType<typeof readSettings>['caption']} caption
 * @returns {string}
 */
export function captionKeyOf(attachmentId, caption, route) {
  const fields = captionKeyFields(attachmentId, caption, route, 'builtin-v3')
  if (!caption.prompt.trim()) fields.push(caption.preset)
  return JSON.stringify(fields)
}

/** 升级期间可用同路由、同参数的旧描述，直到新版提取结果就绪。 */
export function legacyCaptionKeyOf(attachmentId, caption, route) {
  return JSON.stringify(captionKeyFields(attachmentId, caption, route, 'builtin-v2'))
}

function captionKeyFields(attachmentId, caption, route, promptVersion) {
  const prompt = caption.prompt.trim()
  const promptKey = prompt.length ? createHash('sha256').update(prompt).digest('hex') : promptVersion
  return [
    String(attachmentId), route.provider, route.model, caption.style, caption.language,
    caption.maxChars, captionMaxTokens(caption), promptKey,
  ]
}

/**
 * 缩略图缓存键：尺寸或字节目标变了就要重新生成。
 * @param {string} attachmentId
 * @param {ReturnType<typeof readSettings>['thumbnail']} thumbnail
 * @returns {string}
 */
export function thumbKeyOf(attachmentId, thumbnail) {
  return `${String(attachmentId)}|${thumbnail.longEdge}|${thumbnail.maxBytes}`
}

/**
 * 推导状态文件路径。
 * @param {ReturnType<typeof readSettings>} settings
 * @param {{ profileDir?: string, homeDir?: string, profileName?: string }} env
 * @returns {string} 绝对路径。
 */
export function resolveStatePath(settings, env) {
  if (typeof settings.state.path === 'string' && settings.state.path.trim().length > 0) {
    return path.resolve(settings.state.path.trim())
  }
  const homeDir = env.homeDir ?? path.join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh')
  if (settings.state.scope === 'home') return path.join(homeDir, 'image-reference', 'state.json')
  const profileDir = env.profileDir ?? path.join(homeDir, 'profiles', env.profileName ?? process.env.DSH_PROFILE ?? 'web')
  return path.join(profileDir, 'image-reference', 'state.json')
}

/**
 * 描述请求的路由：两个字段都填才用配置，否则跟随当前请求。
 * 只填一个视为配置不完整，回退到当前请求并给出 warning 文案。
 * @param {ReturnType<typeof readSettings>} settings
 * @param {string} provider - 当前请求的 provider。
 * @param {string} model - 当前请求的 model。
 * @returns {{ provider: string, model: string, warning: string | null }}
 */
export function resolveCaptionRoute(settings, provider, model) {
  const { provider: configuredProvider, model: configuredModel } = settings.caption
  const hasProvider = typeof configuredProvider === 'string' && configuredProvider.trim().length > 0
  const hasModel = typeof configuredModel === 'string' && configuredModel.trim().length > 0
  if (hasProvider && hasModel) {
    return { provider: configuredProvider.trim(), model: configuredModel.trim(), warning: null }
  }
  if (hasProvider !== hasModel) {
    return {
      provider,
      model,
      warning: 'caption.provider 与 caption.model 必须同时填写；本次回退到当前请求路由。',
    }
  }
  return { provider, model, warning: null }
}

/**
 * 描述请求的输出上限：0 表示按 maxChars 自动推算。
 * @param {ReturnType<typeof readSettings>['caption']} caption
 * @returns {number}
 */
export function captionMaxTokens(caption) {
  if (caption.maxTokens > 0) return caption.maxTokens
  return Math.min(1024, Math.max(256, Math.round(caption.maxChars * 2)))
}
