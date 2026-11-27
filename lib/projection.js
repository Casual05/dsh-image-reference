/**
 * dsh-image-reference —— 请求投影。
 *
 * 只在请求副本上改写：会话日志一个字都不动。核心约束（全部由单测钉住）：
 *   1. 逐块重建，绝不丢块（图片之后的 text / tool-result 外壳原样保留）；
 *   2. 递归进 tool-result（不同 DSH 版本里图片可能嵌在里面）；
 *   3. 首次出现的图片原样保留并等待成功记账；
 *   4. 近期图片保留，原生已卸载图片只生成文本；
 *   5. minImages 阈值不足时只记账、不改写。
 */

import { buildReplacementText } from './text.js'

/** 只有 user / tool 角色允许携带图片；其他角色原样透传。 */
function imageRole(role) {
  return role === 'user' || role === 'tool'
}

/**
 * 这条内容树里有没有图片（递归 tool-result）。
 * @param {readonly any[] | undefined} content
 * @returns {boolean}
 */
export function hasImageDeep(content) {
  if (!Array.isArray(content)) return false
  return content.some(
    (block) => block?.type === 'image'
      || (block?.type === 'tool-result' && hasImageDeep(block.content)),
  )
}

/**
 * 数「未 offloaded 的图片出现」：阈值判断用。offloaded 的块本来就不会再发原图。
 * @param {readonly any[] | undefined} content
 * @returns {number}
 */
function countUnreplacedImages(content) {
  if (!Array.isArray(content)) return 0
  let count = 0
  for (const block of content) {
    if (block?.type === 'image' && block.offloaded !== true) count += 1
    else if (block?.type === 'tool-result') count += countUnreplacedImages(block.content)
  }
  return count
}

/**
 * 一次「图片出现」的稳定 key：sessionId + message.id + 内容树路径 + attachmentId。
 * 顶层路径是纯数字（"3"），tool-result 内是点分（"3.1"），与 dsh-image-once 兼容。
 * @param {unknown} sessionId
 * @param {{ id?: string } | undefined} message
 * @param {string} path
 * @param {{ attachment?: { attachmentId?: string } }} block
 * @returns {string}
 */
export function occurrenceKey(sessionId, message, path, block) {
  const scope = sessionId === undefined ? '-' : String(sessionId)
  const messageId = typeof message?.id === 'string' ? message.id : `#${path}`
  const attachmentId = block?.attachment?.attachmentId ?? '?'
  return `${scope}\u0000${messageId}\u0000${path}\u0000${attachmentId}`
}

/**
 * 把请求历史投影成「首次原图、后续引用」的副本。
 *
 * env 的每个回调都是同步的：投影绝不能 await 后台生成结果，否则主请求会被
 * 描述/缩略图拖慢。历史图在替代信息足够后才切换。
 *
 * @param {readonly any[]} messages
 * @param {{
 *   sessionId?: unknown,
 *   hasSent: (key: string) => boolean,
 *   minImages: number,
 *   features: { caption: boolean, thumbnail: boolean, minImages: number },
 *   captionFor: (ref: any) => string | undefined,
 *   thumbFor: (ref: any) => any | undefined,
 *   supportsImage: boolean,
 *   pathFor: (ref: any) => string | undefined,
 *   language: string,
 *   keepRecentTurns?: number,
 *   formFor?: (key: string) => string | undefined,
 *   waitForCaption?: (ref: any) => boolean,
 *   waitForThumbnail?: (ref: any) => boolean,
 * }} env
 */
export function projectMessages(messages, env) {
  const pending = []
  const seen = new Map()
  const forms = new Map()
  const pendingKeys = new Set()
  let replaced = 0
  let waiting = 0
  let paths = 0

  // 阈值：先数所有未 offloaded 的图片出现（不管是否已发送）。
  let total = 0
  for (const message of messages) {
    if (imageRole(message?.role)) total += countUnreplacedImages(message.content)
  }
  const replace = total >= Math.max(1, env.minImages)
  const startOfRecent = recentTurnStart(messages, env.keepRecentTurns ?? 0)

  /** 逐块重建一层内容；返回原数组的引用表示没有改动。 */
  const walk = (message, blocks, path, recent) => {
    let next
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index]
      const here = path === '' ? String(index) : `${path}.${index}`

      if (block?.type === 'image') {
        const key = occurrenceKey(env.sessionId, message, here, block)
        const known = typeof message.id === 'string' && env.hasSent(key)
        if (known && block.offloaded !== true) seen.set(key, block.attachment)
        if (block.offloaded === true || (known && replace && !recent)) {
          const result = renderReplacement(block, env, key)
          if (result === null) {
            waiting += 1
          } else if (result !== undefined) {
            next ??= blocks.slice(0, index)
            next.push(...result.blocks)
            if (block.offloaded !== true) {
              forms.set(key, result.form)
              if (result.form === 'path') paths += 1
            }
            replaced += 1
            continue
          }
        }
        if (!known && typeof message.id === 'string' && !pendingKeys.has(key)) {
          pendingKeys.add(key)
          pending.push({ key, ref: block.attachment, messageId: message.id })
        }
      } else if (block?.type === 'tool-result' && Array.isArray(block.content)) {
        const inner = walk(message, block.content, here, recent)
        if (inner !== block.content) {
          next ??= blocks.slice(0, index)
          next.push({ ...block, content: inner })
          continue
        }
      }

      // 普通块（以及内部无改动的 tool-result）原样保留 —— 这一行是「不丢块」的关键。
      if (next !== undefined) next.push(block)
    }
    return next ?? blocks
  }

  let next
  for (const [index, message] of messages.entries()) {
    if (imageRole(message?.role) && Array.isArray(message.content)) {
      const rebuilt = walk(message, message.content, '', index >= startOfRecent)
      if (rebuilt !== message.content) {
        next ??= messages.slice(0, index)
        next.push({ ...message, content: rebuilt })
        continue
      }
    }
    if (next !== undefined) next.push(message)
  }

  return { messages: next ?? messages, pending, seen, forms, replaced, waiting, paths }
}

function recentTurnStart(messages, keep) {
  if (keep <= 0) return messages.length
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.role === 'user' && (message.source === undefined || message.source.kind === 'user')) {
      keep -= 1
      if (keep === 0) return index
    }
  }
  return 0
}

function renderReplacement(block, env, key) {
  const ref = block.attachment
  const offloaded = block.offloaded === true
  const thumb = !offloaded && env.features.thumbnail && env.supportsImage ? env.thumbFor(ref) : undefined
  const caption = env.features.caption ? env.captionFor(ref) : undefined
  const accessPath = env.pathFor(ref)
  if (!offloaded && !accessPath) return undefined
  const previous = offloaded ? undefined : env.formFor?.(key)
  if (!offloaded && previous === undefined && !caption
    && (env.waitForCaption?.(ref) || (!thumb && env.waitForThumbnail?.(ref)))) return null

  // 已稳定的描述不为晚到缩略图改变。路径和缩略图可在描述恢复后补齐信息。
  const attachThumb = Boolean(thumb) && !(previous === 'caption' && caption)
  const form = attachThumb ? (caption ? 'both' : 'thumbnail') : (caption ? 'caption' : 'path')
  const text = buildReplacementText({
    ref,
    accessPath,
    caption,
    language: env.language,
    thumbnailAttached: attachThumb,
  })
  const textBlock = { type: 'text', text }
  return { form, blocks: attachThumb ? [{ type: 'image', attachment: thumb }, textBlock] : [textBlock] }
}
