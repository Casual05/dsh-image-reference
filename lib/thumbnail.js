/**
 * dsh-image-reference —— 缩略图服务。
 *
 * 用 attachment 服务的 readImageRequest() 生成等比小图，再 saveImage() 持久化成
 * 一个新的 content-addressed 附件引用。后续请求直接把 image block 的 attachment
 * 换成这个引用即可——adapter 会按正常图片内联，不需要我们碰 base64。
 *
 * 生成完全后台，在成功请求后按需入队。
 */

import { thumbKeyOf } from './config.js'

const THUMB_TIMEOUT_MS = 60_000

export class ThumbnailService {
  /**
   * @param {{
   *   attachments: { readImageRequest: Function, saveImage: Function },
   *   settings: () => any,
   *   state: import('./state.js').StateStore,
   *   logger?: { info?: Function, warn?: Function },
   *   timeoutMs?: number,
   * }} options
   */
  constructor(options) {
    this.attachments = options.attachments
    this.settings = options.settings
    this.state = options.state
    this.logger = options.logger
    this.timeoutMs = options.timeoutMs ?? THUMB_TIMEOUT_MS

    this.queue = []
    this.inFlight = new Set()
    this.running = 0
    this.stopped = false
    this.waiters = []
    this.lifetime = new AbortController()
    this.ok = 0
    this.failed = 0
    this.skipped = 0
  }

  /** 把一张图加入缩略图队列；按 thumbKey 去重。 */
  enqueue(task) {
    if (this.stopped || task?.ref?.attachmentId === undefined) return
    const settings = this.settings()
    if (!settings.features.thumbnail) return
    const cfg = settings.thumbnail
    const key = thumbKeyOf(task.ref.attachmentId, cfg)

    if (this.state.getThumb(key) !== undefined) {
      this.skipped += 1
      return
    }
    if (this.state.isCooling(`thumb:${key}`, cfg.cooldownMs)) {
      this.skipped += 1
      return
    }
    if (this.inFlight.has(key) || this.queue.some((item) => item.key === key)) {
      this.skipped += 1
      return
    }
    if (this.queue.length >= cfg.maxQueue) {
      this.warn(`缩略图队列已满（${cfg.maxQueue}），本次跳过`)
      this.skipped += 1
      return
    }

    this.queue.push({ key, ref: task.ref, cfg, signal: this.lifetime.signal })
    this.pump()
  }

  pump() {
    if (this.stopped) return
    const concurrency = Math.max(1, this.settings().thumbnail.concurrency)
    while (this.running < concurrency && this.queue.length > 0) {
      const task = this.queue.shift()
      this.inFlight.add(task.key)
      this.running += 1
      void this.runTask(task)
        .catch(() => {})
        .finally(() => {
          this.running -= 1
          this.inFlight.delete(task.key)
          if (this.queue.length === 0 && this.running === 0) this.settleWaiters()
          else this.pump()
        })
    }
  }

  async runTask(task) {
    const { cfg } = task
    if (task.signal.aborted || !this.isCurrent(task)) return
    const dims = longEdgeDimensions(task.ref.width, task.ref.height, cfg.longEdge)
    const signal = AbortSignal.any([task.signal, AbortSignal.timeout(this.timeoutMs)])

    try {
      const request = await this.attachments.readImageRequest(
        task.ref,
        { width: dims.width, height: dims.height, maxBytes: cfg.maxBytes },
        signal,
      )
      signal.throwIfAborted()
      if (!this.isCurrent(task)) return
      if (request === undefined || request === null || request.data === undefined) {
        throw new Error('readImageRequest returned no data')
      }
      const saved = await this.attachments.saveImage({
        data: request.data,
        mediaType: request.mediaType,
        name: 'image-reference-thumb',
      })
      signal.throwIfAborted()
      if (!this.isCurrent(task)) return
      if (!isSmallerThumbnail(saved, task.ref, cfg)) throw new Error('thumbnail exceeds limits or does not reduce image size')
      this.state.putThumb(task.key, saved)
      this.ok += 1
      this.info(`缩略图完成 ${shortId(task.ref.attachmentId)}（${saved.width}x${saved.height}）`)
    } catch (error) {
      if (task.signal.aborted || !this.isCurrent(task)) return
      this.failed += 1
      const reason = `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`.slice(0, 200)
      this.state.markFailure(`thumb:${task.key}`, reason)
      this.warn(`缩略图失败 ${shortId(task.ref.attachmentId)}：${reason}`)
    }
  }

  isCurrent(task) {
    const settings = this.settings()
    return settings.features.thumbnail && thumbKeyOf(task.ref.attachmentId, settings.thumbnail) === task.key
  }

  reset() {
    this.lifetime.abort()
    this.lifetime = new AbortController()
    this.queue.length = 0
    if (this.running === 0) this.settleWaiters()
  }

  stop() {
    this.stopped = true
    this.reset()
  }

  drain() {
    if (this.running === 0 && this.queue.length === 0) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  stats() {
    return { queued: this.queue.length, running: this.running, ok: this.ok, failed: this.failed, skipped: this.skipped }
  }

  settleWaiters() {
    const waiters = this.waiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  info(message) {
    this.logger?.info?.(`[image-reference] ${message}`)
  }

  warn(message) {
    this.logger?.warn?.(`[image-reference] ${message}`)
  }
}

/**
 * 等比缩放的整数尺寸；长边小于目标时保持原尺寸（只缩不放）。
 * 与 @deepseek-ai/dsh-attachment 的 longEdgeDimensions 同语义，复制一份是为了
 * 让 thumbnail 模块零 DSH 依赖、可单测。
 * @param {number} width
 * @param {number} height
 * @param {number} longEdge
 * @returns {{ width: number, height: number }}
 */
export function longEdgeDimensions(width, height, longEdge) {
  const w = Math.max(1, Math.round(Number(width) || 1))
  const h = Math.max(1, Math.round(Number(height) || 1))
  const edge = Math.max(1, Math.round(Number(longEdge) || 1))
  if (edge >= Math.max(w, h)) return { width: w, height: h }
  return w >= h
    ? { width: edge, height: Math.max(1, Math.round(edge * h / w)) }
    : { width: Math.max(1, Math.round(edge * w / h)), height: edge }
}

export function isSmallerThumbnail(thumb, ref, cfg) {
  return thumb?.attachmentId !== ref.attachmentId
    && thumb?.bytes > 0 && thumb.bytes <= cfg.maxBytes && thumb.bytes < ref.bytes
    && thumb.width > 0 && thumb.height > 0
    && Math.max(thumb.width, thumb.height) <= cfg.longEdge
    && Math.max(thumb.width, thumb.height) < Math.max(ref.width, ref.height)
}

function shortId(id) {
  const value = String(id)
  return value.length > 20 ? `${value.slice(0, 20)}…` : value
}
