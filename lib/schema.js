/**
 * dsh-image-reference —— schemastery 配置 schema。
 *
 * 每个顶层块都 `.volatile()`：设置页写入走 loader 的快速路径，不重挂插件；
 * 插件每次请求现读，所以改完即时生效。
 *
 * 注意：不要在这里 import 插件运行时；这个文件只被 lib/index.js 引用。
 */

import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  features: z.object({
    /** 允许生成/使用文字描述。 */
    caption: z.boolean().default(true),
    /** 允许生成/使用小缩略图。 */
    thumbnail: z.boolean().default(true),
    /** 接管阈值：未 offloaded 的图片出现数达到该值才替换。 */
    minImages: z.number().step(1).min(1).max(50).default(1),
    keepRecentTurns: z.number().step(1).min(0).max(10).default(1),
  }).default({ caption: true, thumbnail: true, minImages: 1, keepRecentTurns: 1 }).volatile(),

  /** provider 名单；空 = 全部生效。语义与 dsh-image-once 一致。 */
  providers: z.dict(z.object({
    enabled: z.boolean().default(true),
    models: z.array(z.string()).default([]),
  })).default({}).volatile(),

  caption: z.object({
    /** 空 = 跟随当前请求。两个字段都填才生效。 */
    provider: z.string().default(''),
    model: z.string().default(''),
    preset: z.union(['auto', 'standard', 'error-screenshot']).default('auto'),
    style: z.union(['structured', 'brief', 'ocr']).default('structured'),
    language: z.union(['en', 'zh', 'auto']).default('en'),
    maxChars: z.number().step(1).min(80).max(2000).default(400),
    /** 0 = 按 maxChars 自动推算。 */
    maxTokens: z.number().step(1).min(0).max(2048).default(0),
    concurrency: z.number().step(1).min(1).max(8).default(2),
    timeoutMs: z.number().step(1).min(1000).max(300000).default(60_000),
    retries: z.number().step(1).min(0).max(3).default(1),
    cooldownMs: z.number().step(1).min(0).default(600_000),
    maxQueue: z.number().step(1).min(1).max(1000).default(200),
    /** 非空时完全替代内置 system prompt。 */
    prompt: z.string().default(''),
  }).default({}).volatile(),

  thumbnail: z.object({
    longEdge: z.number().step(1).min(64).max(1024).default(320),
    maxBytes: z.number().step(1).min(4096).max(1_048_576).default(65_536),
    concurrency: z.number().step(1).min(1).max(4).default(1),
    maxQueue: z.number().step(1).min(1).max(1000).default(200),
    cooldownMs: z.number().step(1).min(0).default(600_000),
  }).default({}).volatile(),

  state: z.object({
    persist: z.boolean().default(true),
    scope: z.union(['profile', 'home']).default('profile'),
    /** 非空时直接覆盖 scope 推导出的路径。 */
    path: z.string().default(''),
    /** 设置页「清空记忆」写入的时间戳；宿主监听后清空。 */
    clearToken: z.number().default(0),
    clearCaptionsToken: z.number().default(0),
    maxOccurrences: z.number().step(1).min(100).default(20_000),
    maxEntries: z.number().step(1).min(100).default(10_000),
  }).default({}).volatile(),

  log: z.union(['off', 'summary', 'verbose']).default('summary').volatile(),
})
