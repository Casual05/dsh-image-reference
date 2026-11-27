/**
 * dsh-image-reference —— 持久化状态。
 *
 * 记三件事：哪些图片出现已经发过（sent）、每张图的描述（captions）、
 * 缩略图引用（thumbs）。JSON 纯文本，写入走「tmp + rename」原子替换。
 *
 * sent 和替换形态按出现次数管理，容量到顶时按记录时间淘汰。
 */

import fs from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

const VERSION = 1
const FLUSH_DELAY_MS = 1000
const MAX_WRITE_RETRIES = 2

/** 空状态。 */
function emptyState() {
  return {
    version: VERSION,
    updatedAt: 0,
    sent: {},
    captions: {},
    thumbs: {},
    failures: {},
    forms: {},
  }
}

/** 把未知值收敛成普通对象。 */
function recordOf(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

export class StateStore {
  /**
   * @param {{
   *   file: string,
   *   persist?: boolean,
   *   maxOccurrences?: number,
   *   maxEntries?: number,
   *   logger?: { info?: Function, warn?: Function },
   *   replaceFile?: typeof rename,
   * }} options
   */
  constructor(options) {
    this.file = options.file
    this.persist = options.persist !== false
    this.maxOccurrences = options.maxOccurrences ?? 20_000
    this.maxEntries = options.maxEntries ?? 10_000
    this.logger = options.logger ?? console
    this.replaceFile = options.replaceFile ?? rename
    this.data = emptyState()
    this.dirty = false
    this.timer = null
    this.closed = false
    this.writing = null
    this.closing = null
    this.writeRetries = 0
  }

  /** 同步读取；文件损坏时备份并重建，绝不让坏状态阻断插件启动。 */
  load() {
    if (!this.persist) return
    let text
    try {
      text = fs.readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.warn(`读取状态文件失败：${error?.message ?? error}`)
      return
    }
    try {
      const parsed = JSON.parse(text)
      if (parsed === null || typeof parsed !== 'object' || parsed.version !== VERSION) throw new Error(`unsupported state version ${parsed?.version}`)
      this.data = {
        version: VERSION,
        updatedAt: Number(parsed.updatedAt) || 0,
        sent: recordOf(parsed.sent),
        captions: recordOf(parsed.captions),
        thumbs: recordOf(parsed.thumbs),
        failures: recordOf(parsed.failures),
        forms: recordOf(parsed.forms),
      }
    } catch (error) {
      const backup = `${this.file}.bad-${Date.now()}`
      try {
        fs.renameSync(this.file, backup)
        this.warn(`状态文件损坏，已备份到 ${backup}：${error?.message ?? error}`)
      } catch (renameError) {
        this.warn(`状态文件损坏且无法备份（${renameError?.message ?? renameError}），将重建。`)
      }
      this.data = emptyState()
    }
  }

  /** 某个图片出现是否已经发过。 */
  isSent(key) {
    return Object.hasOwn(this.data.sent, key)
  }

  /** 记账一批 occurrence key（内存立即生效，磁盘 debounce）。 */
  markSent(keys) {
    const now = Date.now()
    let changed = false
    for (const key of keys) {
      if (typeof key !== 'string' || key.length === 0) continue
      this.data.sent[key] = now
      changed = true
    }
    if (changed) this.touch()
  }

  /** 读取一条描述条目。 */
  getCaption(key) {
    const entry = this.data.captions[key]
    return entry !== null && typeof entry === 'object' ? entry : undefined
  }

  /** 读取描述文本（投影只需要文字）。 */
  getCaptionText(key) {
    const entry = this.getCaption(key)
    return typeof entry?.text === 'string' && entry.text.length > 0 ? entry.text : undefined
  }

  putCaption(key, entry) {
    delete this.data.failures[key]
    this.data.captions[key] = {
      text: String(entry.text ?? ''),
      model: String(entry.model ?? ''),
      style: String(entry.style ?? ''),
      language: String(entry.language ?? ''),
      chars: Number(entry.chars) || 0,
      ...(entry.data === undefined ? {} : { data: entry.data }),
      createdAt: Date.now(),
    }
    this.touch()
  }

  /** 读取缩略图 ref。 */
  getThumb(key) {
    const entry = this.data.thumbs[key]
    const ref = entry?.ref
    if (ref === null || typeof ref !== 'object' || typeof ref.attachmentId !== 'string') return undefined
    return ref
  }

  forgetThumb(key) {
    if (Object.hasOwn(this.data.thumbs, key)) {
      delete this.data.thumbs[key]
      this.touch()
    }
  }

  getForm(key, policy) {
    const entry = this.data.forms[key]
    return entry?.policy === policy ? entry.form : undefined
  }

  putForm(key, policy, form) {
    if (!this.isSent(key)) return
    const previous = this.getForm(key, policy)
    if (previous === form) return
    const upgraded = previous === 'path' || (previous === 'thumbnail' && (form === 'caption' || form === 'both'))
    if (previous !== undefined && !upgraded) return
    this.data.forms[key] = { policy, form, at: Date.now() }
    this.touch()
  }

  putThumb(key, ref) {
    delete this.data.failures[`thumb:${key}`]
    this.data.thumbs[key] = { ref, createdAt: Date.now() }
    this.touch()
  }

  /** 最近一次生成失败，投影可以继续使用较轻的替代形态。 */
  hasFailure(key) {
    return Number.isFinite(this.data.failures[key]?.at)
  }

  /** 冷却只限制后台重试。 */
  isCooling(key, cooldownMs, now = Date.now()) {
    if (cooldownMs <= 0) return false
    const at = Number(this.data.failures[key]?.at)
    return Number.isFinite(at) && at + cooldownMs > now
  }

  markFailure(key, reason) {
    this.data.failures[key] = { at: Date.now(), reason: String(reason ?? '') }
    this.touch()
  }

  /** 清空全部缓存（设置页「清空记忆」）。 */
  clearAll() {
    this.data = emptyState()
    this.touch()
    return this.flush()
  }

  /** 只清某几类缓存。 */
  clearCaches(kinds = ['sent', 'captions', 'thumbs', 'failures']) {
    for (const kind of kinds) {
      if (kind in this.data && kind !== 'version' && kind !== 'updatedAt') this.data[kind] = {}
    }
    if (kinds.includes('captions')) {
      for (const key of Object.keys(this.data.failures)) {
        if (!key.startsWith('thumb:')) delete this.data.failures[key]
      }
    }
    // 只清描述时保留已投影的历史图记录，重算期间继续用路径或已有缩略图。
    if (kinds.includes('sent')) this.data.forms = {}
    this.touch()
    return this.flush()
  }

  /** 统计信息（设置页展示用）。 */
  stats() {
    let bytes = 0
    try {
      bytes = fs.statSync(this.file).size
    } catch {
      bytes = 0
    }
    return {
      sent: Object.keys(this.data.sent).length,
      captions: Object.keys(this.data.captions).length,
      thumbs: Object.keys(this.data.thumbs).length,
      failures: Object.keys(this.data.failures).length,
      bytes,
      file: this.file,
    }
  }

  /** 立即落盘（测试、卸载、清空时用）。 */
  flush() {
    if (this.writing !== null) return this.writing
    if (!this.dirty || this.closed) return Promise.resolve()
    this.cancelFlush()
    this.writing = this.writePending().finally(() => { this.writing = null })
    return this.writing
  }

  async writePending() {
    while (this.dirty) {
      this.dirty = false
      this.prune()
      if (!this.persist) return
      this.data.updatedAt = Date.now()
      const tmp = `${this.file}.${process.pid}.${randomUUID()}.tmp`
      try {
        await mkdir(path.dirname(this.file), { recursive: true })
        await writeFile(tmp, JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
        await this.replaceFile(tmp, this.file)
        this.writeRetries = 0
      } catch (error) {
        this.dirty = true
        await rm(tmp, { force: true }).catch(() => {})
        this.warn(`写入状态文件失败：${error?.message ?? error}`)
        if (this.writeRetries < MAX_WRITE_RETRIES) {
          const delay = FLUSH_DELAY_MS * 2 ** this.writeRetries
          this.writeRetries += 1
          this.cancelFlush()
          this.scheduleFlush(delay)
        }
        return
      }
    }
  }

  /** 关掉 debounce 计时器并落盘。 */
  close() {
    if (this.closing !== null) return this.closing
    this.cancelFlush()
    this.closing = this.flush().finally(() => { this.closed = true })
    return this.closing
  }

  touch() {
    this.dirty = true
    if (this.timer === null && this.writing === null) this.writeRetries = 0
    this.scheduleFlush(FLUSH_DELAY_MS)
  }

  cancelFlush() {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
  }

  scheduleFlush(delay) {
    if (this.closed || this.closing !== null) return
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, delay)
    this.timer.unref?.()
  }

  /** 按时间戳淘汰最旧条目。 */
  prune() {
    pruneRecord(this.data.sent, this.maxOccurrences)
    pruneRecord(this.data.captions, this.maxEntries)
    pruneRecord(this.data.thumbs, this.maxEntries)
    pruneRecord(this.data.failures, this.maxEntries)
    for (const key of Object.keys(this.data.forms)) {
      if (!this.isSent(key)) delete this.data.forms[key]
    }
  }

  warn(message) {
    this.logger?.warn?.(`[image-reference] ${message}`)
  }
}

/** 按条目里的时间字段淘汰最旧，保持记录数不超过 limit。 */
function pruneRecord(record, limit) {
  const keys = Object.keys(record)
  if (keys.length <= limit) return
  keys
    .sort((a, b) => timestampOf(record[a]) - timestampOf(record[b]))
    .slice(0, keys.length - limit)
    .forEach((key) => {
      delete record[key]
    })
}

function timestampOf(entry) {
  if (typeof entry === 'number') return Number.isFinite(entry) ? entry : 0
  if (entry === null || typeof entry !== 'object') return 0
  const value = entry.createdAt ?? entry.at
  return Number(value) || 0
}
