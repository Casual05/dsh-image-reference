/**
 * dsh-image-reference —— 路由图片能力探测。
 *
 * thumbnail 模式必须先知道「当前模型收不收图」：如果模型只收文本，adapter 会把
 * 缩略图投影成一句「image omitted because this model accepts text only」，比
 * 纯路径还差。这里用 ctx.llm.prepareCall() 读 inputModalities：
 *   - 明确包含 'image' → 支持；
 *   - 明确不含 → 不支持；
 *   - 未声明 / 查询失败 → 未知，主请求不会为此等待。
 *
 * prepareCall 只做路由准备、不 dispatch，不消耗模型配额。结果缓存 10 分钟，
 * 避免每个请求都打一次模型目录。
 */

const DEFAULT_TTL_MS = 600_000
const DEFAULT_TIMEOUT_MS = 2_000

export class CapabilityCache {
  /**
   * @param {{
   *   llm: { prepareCall: Function },
   *   ttlMs?: number,
   *   timeoutMs?: number,
   * }} options
   */
  constructor(options) {
    this.llm = options.llm
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.cache = new Map()
    this.inFlight = new Map()
    this.lifetime = new AbortController()
  }

  /** 同步区分已知支持、已知不支持与未知。 */
  known(provider, model) {
    const entry = this.cache.get(keyOf(provider, model))
    return entry !== undefined && Date.now() - entry.at < this.ttlMs ? entry.value : undefined
  }

  observe(provider, model, modalities) {
    if (!Array.isArray(modalities)) return undefined
    const value = modalities.includes('image')
    this.cache.set(keyOf(provider, model), { value, at: Date.now() })
    return value
  }

  /**
   * 异步填充缓存。永远不抛：查询失败按「不支持」缓存。
   * @param {string} provider
   * @param {string} model
   * @returns {Promise<boolean>}
   */
  async ensure(provider, model) {
    const key = keyOf(provider, model)
    const cached = this.cache.get(key)
    if (cached !== undefined && Date.now() - cached.at < this.ttlMs) return cached.value === true
    if (this.lifetime.signal.aborted) return false

    const existing = this.inFlight.get(key)
    if (existing !== undefined) return existing

    const lifetime = this.lifetime.signal
    const task = Promise.resolve().then(async () => {
      let value
      const signal = AbortSignal.any([lifetime, AbortSignal.timeout(this.timeoutMs)])
      const cancellation = new Promise((resolve) => {
        signal.addEventListener('abort', () => resolve(undefined), { once: true })
      })
      try {
        signal.throwIfAborted()
        const call = await Promise.race([this.llm.prepareCall({ provider, model }, signal), cancellation])
        const modalities = call?.inputModalities
        if (Array.isArray(modalities)) value = modalities.includes('image')
      } catch {
        // 未知与明确不支持分开，供描述任务决定是否尝试。
      } finally {
        if (this.inFlight.get(key) === task) this.inFlight.delete(key)
      }
      if (!lifetime.aborted && this.cache.get(key) === cached) {
        this.cache.set(key, { value, at: Date.now() })
      }
      return this.known(provider, model) === true
    })

    this.inFlight.set(key, task)
    return task
  }

  /** 清空缓存（设置变更后调用）。 */
  clear() {
    this.stop()
    this.lifetime = new AbortController()
  }

  stop() {
    this.lifetime.abort()
    this.cache.clear()
    this.inFlight.clear()
  }
}

function keyOf(provider, model) {
  return `${String(provider)}\u0000${String(model)}`
}
