# dsh-image-reference 设计文档（草案 v0.1）

> 2026-11-26 的原始设计记录。请求记账、回退、持久化与设置页行为已在实现中调整。
> 当前行为和设置说明见 [README](README.zh.md)。本文其余章节保留当时的方案，用于比较。
> 原设计目标环境为 DSH 0.2.2-rc.5、`web` profile。

---

## 0. 一句话

每个图片块只在它出现的那一次请求里内联原图；之后的请求把它替换成「本地只读路径 + 自动生成的图片描述」，可选再附一张小缩略图，让模型既不重传图片字节，也不丢失对图片的记忆。

---

## 1. 目标与非目标

### 目标

1. 显著减小长会话中重复内联图片带来的请求体与视觉 token 开销（与 `dsh-image-once` 同目标）。
2. 比纯路径多保留一层语义：后续请求能看到图片的文字描述，不必每次都 `read_image` 重看。
3. 两种增强形态都可独立开关：`caption`（文字描述）、`thumbnail`（小图）。
4. 默认行为安全：描述未就绪、模型不支持图片、插件内部出错时，都退回「纯路径」或原样发送，不阻断会话。
5. 状态可持久化：重启后不重发历史图片，已生成的描述不重算。

### 非目标

- 不修改 DSH 源码或打包产物。
- 不把改写写回会话日志（只改请求副本）。
- 不注册新的 provider 路由（避免破坏 replay state）。
- 不替代原生 `dsh-compaction-image-offload`；预算触发的 offload 仍由原生流程处理。
- 不做独立 OCR 引擎；`caption` 的视觉模型就是 OCR 通道。
- 设置页卡片是 v0.1 的交付内容（用户已确认）；YAML 配置仍保留，作为高级入口与故障兜底。

---

## 2. 与 dsh-image-once 的关系

| | dsh-image-once 0.2.0 | 本插件 |
|---|---|---|
| 后续请求表示 | 给 image block 打 `offloaded: true`，由 adapter 生成固定占位文本 | 直接把 image block 替换成 text block（或缩略图 image block + text） |
| 文案 | 不可定制（`offloadedImageText` 写死） | 完全自定义：路径 + 描述 + 提示 |
| 额外模型调用 | 无 | caption 开启时每张图一次 |
| 持久化 | 无（重启后历史图重发） | sent / caption / thumb 三类缓存 |
| 缩略图 | 无 | 可选 |

**不要同时安装两个插件**：两者都会包裹 `ctx.llm.adapters`，叠加后会互相改写。插件启动时若检测到 `dsh-image-once` 已包裹的 adapter（或通过 loader 行名判断），打 warn 并禁用自己（fail-open）。

本插件复用 image-once 的以下设计（不复制代码）：

- `occurrenceKey = sessionId + message.id + 内容树路径 + attachmentId`
- 就地替换 `ctx.llm.adapters` 里的 adapter 实例（Proxy），监听 `llm/adapters-updated` 重新包裹
- 首个 chunk 到达后才记账
- 递归进 `tool-result`
- 逐块重建，绝不丢块

---

## 3. 已确认的产品决策

| 决策 | 结论 |
|---|---|
| 形态 | `caption` 与 `thumbnail` 都做，作为独立开关 |
| 设置页 | v0.1 就交付设置页卡片 |
| 描述模型 | 默认跟随当前请求的 provider/model；可显式指定 |
| 描述风格 | 默认 `structured`；`brief` / `ocr` 可选 |
| 描述语言 | 默认 `en`；可切 `zh` / `auto` |
| 接管时机 | 默认 `minImages = 1`；可配置从第 N 张图开始 |
| 状态文件 | 默认当前 profile 专属目录；可切全局 |
| 依赖策略 | 借用官方公开函数；`engines.dsh` 限 0.2.x |
| 推进方式 | 设计文档已完成；确认后按 P1–P5 开始实现 |

---

## 4. 行为规格

### 4.1 一次「图片出现」的定义

```
occurrenceKey = `${sessionId}\0${messageId}\0${path}\0${attachmentId}`
```

- `path`：块在整条消息内容树里的位置，顶层是 `"3"`，`tool-result` 内是 `"3.1"`（与 image-once 一致，历史 key 可兼容）。
- `messageId`：`message.id`；没有 id 的请求级 user input 用 `#${path}` 回退。
- 同一张图（同一 `attachmentId`）在不同消息/位置 = 不同出现，各自记账。
- `caption` / `thumbnail` 缓存按 `attachmentId`（加配置维度）共享，不按出现重复生成。

### 4.2 首次 vs 后续

- **首次出现**：该 key 不在 `sent` 集合 → 原图内联，key 进入 `pending`。
- **记账时机**：该请求产出第一个 chunk 后，才把 `pending` 写入 `sent` 并触发 caption/thumbnail 后台生成。失败/重试不算已发。
- **后续出现**：key 在 `sent` 中，且当前请求里「未替换的图片出现数」≥ `features.minImages` → 按回退链替换；低于阈值 → 原样保留原图（继续重发，直到图片数够多）。首次出现仍照常记账，只是不替换。
- **`read_image` 重看**：工具结果是新 message.id + 新路径 = 新出现 → 再内联一次；caption/thumbnail 命中缓存，不重复生成。
- **已 `offloaded: true` 的块**：直接按回退链替换，不进入 `pending`（尊重原生 offload 决定）。

### 4.3 替代形态

| 形态 | 请求里的内容 | 额外成本 |
|---|---|---|
| `path` | 一个 text block：attachmentId、尺寸、格式、只读路径、`read_image` 提示 | 无 |
| `caption` | 一个 text block：路径信息 + 自动描述 + 「可能不准确」提示 | 每张图一次视觉调用 |
| `thumbnail` | image block（长边 `longEdge` 的小图）+ 一个 text block（路径信息） | 一次本地缩放/编码（无模型调用） |
| `both` | image block（缩略图）+ 一个 text block（路径 + 描述） | 两者之和 |

### 4.4 回退链

**阈值前置**：先数当前请求里所有「未 offloaded 的图片出现」（不管是否已发送）。若数量 < `features.minImages`，本次完全不替换，所有图原样内联；只记录首次出现的 `pending`，供下次判断。

通过阈值后，每次替换一张已发送的图，按以下顺序选择：

1. `features.thumbnail && 路由支持图片 && 缩略图缓存已就绪` → `thumbnail` 或 `both`。
2. `features.caption && 描述缓存已就绪` → `caption`。
3. 否则 → `path`。

**缓存未就绪不等待**：caption/thumbnail 都是后台生成；本次请求没赶上就用 `path`，下一次请求自动升级。这样主请求永远不会因为插件而变慢。

### 4.5 组合语义

以 `features.caption` / `features.thumbnail` 两个布尔为准，不引入 `mode` 枚举：

| caption | thumbnail | 实际形态 |
|---|---|---|
| false | false | path |
| true | false | caption（未就绪时 path） |
| false | true | thumbnail + path 文本（未就绪/不支持图时 path） |
| true | true | thumbnail + caption 文本（缩略图未就绪时退 caption，描述未就绪时退 path） |

### 4.6 与原生 image-offload 的关系

- 被我们替换成 text 的图片，adapter 的 `contentHasImage` 看不到 → 不参与原生预算，也不会触发 `IMAGE_OFFLOAD_REQUIRED`。
- 首次出现、尚未替换的图片仍参与原生预算；若原生决定 offload，adapter 会在重试时看到 `offloaded: true`，我们按 4.2 直接替换（不重复内联）。
- 持久化 `sent` 后，重启不再重发历史图，这一点优于 image-once。

---

## 5. 配置

### 5.1 完整 YAML（写入 profile 的 `cordis.patch.yml`）

```yaml
- id: image-reference
  config:
    features:
      caption: true
      thumbnail: true
      minImages: 1           # 历史里未替换的图片出现数达到该值才开始接管；1 = 每张图都接管
    providers: {}            # 空 = 所有 provider 生效；语义同 dsh-image-once
    caption:
      provider: ""           # 空 = 跟随当前请求的 provider
      model: ""              # 空 = 跟随当前请求的 model
      style: structured      # structured | brief | ocr
      language: en           # en | zh | auto（auto = 跟随图片里的文字语言）
      maxChars: 400
      maxTokens: 0           # 0 = 自动（约 maxChars * 2，上限 1024）
      concurrency: 2
      timeoutMs: 60000
      retries: 1
      cooldownMs: 600000     # 失败后 10 分钟内不重试
      prompt: ""             # 空 = 内置 prompt
    thumbnail:
      longEdge: 320
      maxBytes: 65536
      concurrency: 1
    state:
      persist: true
      scope: profile         # profile | home（profile = 当前 profile 专属目录）
      path: ""               # 空 = 按 scope 推导；非空 = 直接使用该路径
      clearToken: 0          # 设置页“清空记忆”写这个时间戳，宿主监听后清空
      maxOccurrences: 20000
      maxEntries: 10000
    log: summary             # off | summary | verbose
```

### 5.2 字段语义

**features**

- `caption`：允许生成/使用文字描述。
- `thumbnail`：允许生成/使用小缩略图。
- `minImages`：接管阈值。当前请求里「尚未替换的图片出现数」达到该值，才把这些已发送的图换成文字/缩略图；低于阈值时，已发送的图仍然原样重发。`1` = 每张图发过一次就接管（默认）；`3` = 历史里至少 3 张图才接管。同一张图在历史里出现多次按出现次数计。
- 两者都 false = 纯路径模式（等于「更省事版的 image-once」）。

**providers**

- 键是**适配器注册名**（宿主日志里 `已包裹 provider "xxx"` 的那个名字），不是 displayName。
- `enabled: false`：该 provider 完全不进本插件（图片照常每次内联）。
- `models: [...]`：只对这些模型生效；空数组 = 该 provider 全部模型。
- 没出现过的 provider = 生效。

**caption**

- `provider`/`model` 同时为空 → 跟随当前请求。只填一个 → 视为无效，打 warn 并按「跟随」处理。
- `style`：
  - `structured`：画面 + 文字/OCR + 关键元素，按 `maxChars` 截断。
  - `brief`：一句话，建议 `maxChars ≤ 160`。
  - `ocr`：优先抄全图中文字，画面描述从简。
- `language`：`en` 默认（token 更省）；`zh` 可读性更好；`auto` = 跟随图片里的主要文字语言。只影响占位文本与 prompt，不影响模型是否能识别中文。
- `maxChars`：描述硬上限，超出截断并加省略号。
- `maxTokens`：0 = `min(1024, max(256, maxChars * 2))`。
- `concurrency`：全局 caption 并发上限（跨 provider 共享）。
- `timeoutMs` / `retries` / `cooldownMs`：单张图的超时、重试次数、失败冷却。
- `prompt`：非空时完全替代内置 system prompt（高级选项）。

**thumbnail**

- `longEdge`：长边像素，短边按比例；只缩不放（原图更小则保留原尺寸）。
- `maxBytes`：编码字节目标；`readImageRequest` 会走质量阶梯，达不到就取最小输出。
- `concurrency`：缩略图生成并发（本地 CPU，默认 1）。

**state**

- `persist=false`：只存内存，重启后历史图重发（与 image-once 一致）。
- `scope`：默认 `profile`，状态文件放在当前 profile 的专属目录 `$DSH_PROFILE_DIR/image-reference/state.json`（本机 = `~/.dsh/profiles/web/image-reference/state.json`）；`home` = `$DSH_HOME/image-reference/state.json`，所有 profile 共用一份。
- `path`：非空时直接覆盖上面推导出的路径（绝对路径）。
- `clearToken`：设置页“清空记忆”按钮写入当前时间戳；宿主监听到变化后清空内存与文件。普通用户不用手改。
- `maxOccurrences`：`sent` 记账上限，LRU 淘汰最旧。
- `maxEntries`：`captions` / `thumbs` 各自上限，LRU 淘汰。

**log**

- `off`：只打错误。
- `summary`：启动包裹数、每张图首次内联、caption 成功/失败（不含每次请求）。
- `verbose`：额外打每次投影的替换数量、缓存命中。

### 5.3 约束

- 配置全部 `volatile()`：改完即时生效，不重挂插件；每次请求/每个后台任务现读。
- `features` 改动即时生效；`caption.style`/`maxChars` 改动会让旧描述缓存不命中（按配置维度分键），重新生成。
- 不要在 profile 的 `cordis.patch.yml` 里写 `insert:` 加同 id；包自带 patch 已插入。

---

## 6. 数据模型与持久化

### 6.1 state.json

文件位置见 5.2 的 `state.scope`：默认 `$DSH_PROFILE_DIR/image-reference/state.json`（本机 `~/.dsh/profiles/web/image-reference/state.json`）；`scope: home` 时为 `$DSH_HOME/image-reference/state.json`。

```json
{
  "version": 1,
  "updatedAt": 1795700000000,
  "sent": {
    "<sessionId>": {
      "<occurrenceKey>": 1795700000000
    }
  },
  "captions": {
    "<captionKey>": {
      "text": "画面：……\n文字：……\n关键元素：……",
      "model": "deepseek-official/deepseek-flash",
      "style": "structured",
      "language": "en",
      "chars": 312,
      "createdAt": 1795700000000
    }
  },
  "thumbs": {
    "<thumbKey>": {
      "ref": {
        "attachmentId": "sha256:...",
        "mediaType": "image/jpeg",
        "bytes": 18432,
        "width": 320,
        "height": 180
      },
      "createdAt": 1795700000000
    }
  },
  "failures": {
    "<captionKey>": { "at": 1795700000000, "reason": "no-image-modality" }
  }
}
```

**键**

- `occurrenceKey`：见 4.1，完整字符串（可读，便于排障）。
- `captionKey = attachmentId + '|' + style + '|' + language + '|' + maxChars`
- `thumbKey = attachmentId + '|' + longEdge + '|' + maxBytes`

**写入策略**

- 启动时同步读（文件通常 < 2 MB）；解析失败 → 备份为 `state.json.bad-<ts>`，重建空状态，打 warn。
- 运行期 debounce 1s，原子写：`state.json.tmp` → `rename`。
- 插件卸载（`ctx.effect` 的 disposer）时 flush 一次。
- 写入失败只打 warn，不影响请求。

**清理**

- `sent` 超过 `maxOccurrences`：按时间戳淘汰最旧。
- `captions` / `thumbs` 超过 `maxEntries`：各自 LRU。
- 会话被删除时无法感知（插件没有会话删除事件）；靠上限兜底。

### 6.2 隐私

`state.json` 是**明文**，`captions` 里可能包含截图中的文字（密码、密钥、个人信息）。文档与设置页要明确提示；不需要时设 `state.persist=false` 或定期清理。

---

## 7. 运行时架构

### 7.1 总览

```
                         ┌──────────────────────────────┐
  agent loop ── request ─▶│  LlmRuntime                    │
                         │  ctx.llm.adapters: Map         │
                         └──────────────┬───────────────┘
                                        │ 我们替换的 adapter (Proxy)
                                        ▼
                         ┌──────────────────────────────┐
                         │ dispatch(options)             │
                         │  purpose 非空 / 无图 / 关闭 → 直通
                         │  1. await ensureCapabilities  │
                         │  2. projectMessages (同步)     │
                         │  3. stream = inner.stream     │
                         │  4. 首 chunk 后 commit        │
                         └──────┬───────────────┬───────┘
                                │               │
                    ┌───────────▼──┐    ┌───────▼─────────┐
                    │ StateStore   │    │ CaptionQueue     │
                    │ sent/captions│    │ ThumbnailQueue   │
                    │ thumbs       │    │ (后台，独立)     │
                    └──────────────┘    └──────────────────┘
```

### 7.2 adapter 包裹

与 image-once 相同：

- `inject: ['llm', 'attachments']`；可选 `ctx.get('fs')` 做路径映射。
- 启动时遍历 `ctx.llm.adapters`，把每个 `registration.adapter` 换成 Proxy；保留原始实例，卸载时换回。
- 监听 `llm/adapters-updated` 重新扫描（新 provider 出现时补包）。
- `stream` 与 `prepareCall` 两个入口都包。
- 不注册新 provider。
- 注册表不可读时 fail-open：不替换、只打 error。

**dispatch 规则**

```js
if (options.purpose !== undefined) return inner(options)        // 辅助请求直通
if (!appliesTo(options.provider, options.model)) return inner(options)
if (!hasImageDeep(options.messages)) return inner(options)
return wrappedAsyncIterable(options)
```

**fail-open 边界**

- 只包「能力查询 + 投影 + 创建内层流」这一段；任何异常 → 打 warn → 用原始 options 调一次 `inner`。
- 内层流在迭代中抛错不吞、不重放（避免重复请求），交给 DSH 的 adapter 错误协议处理。

### 7.3 请求投影

同步纯函数 `projectMessages(messages, env)`。

先做阈值判定：统计所有「未 offloaded 的图片出现」数量 `n`。若 `n < features.minImages`，只遍历收集 `pending`（首次出现），不改写任何块；否则进入下面的替换遍历。

```js
// env: { sessionId, state, features, capabilities, pathOf(ref), logger }
// 返回 { messages, pending: [{ key, ref, messageId }] }

walk(message, blocks, path):
  next = undefined
  for i, block of blocks:
    here = path === '' ? String(i) : `${path}.${i}`
    if block.type === 'image':
      key = occurrenceKey(...)
      if (!state.isSent(key) && block.offloaded !== true):
        push original block
        pending.push({ key, ref: block.attachment, messageId })
      else:
        push ...renderReplacement(block.attachment)   // 1 或 2 个块
      continue
    if block.type === 'tool-result' && Array.isArray(block.content):
      inner = walk(message, block.content, here)
      if inner !== block.content: push { ...block, content: inner }; continue
    if next !== undefined: push block
  return next ?? blocks
```

**正确性要求**（每条都要有单测）：

1. 不丢块：图片之后的 text / tool-result 外壳原样保留。
2. 递归进 `tool-result`。
3. 未改动的消息返回原对象（避免无谓克隆）。
4. `pending` 去重：同一条消息内同一 key 只入队一次。
5. 只处理 user / tool 角色；assistant / system 内容原样（DSH 不允许其中的图）。

**`renderReplacement(ref)`**

```js
const text = buildText(ref)                     // 路径 + 描述（见附录 A）
const canThumb = features.thumbnail && capabilities.supportsImage && state.getThumb(thumbKey)
if (!canThumb) return [{ type: 'text', text }]
return [
  { type: 'image', attachment: state.getThumb(thumbKey).ref },
  { type: 'text', text },
]
```

注意：缩略图的 `ImageAttachmentRef` 是 `saveImage` 返回的持久化引用，满足 `ImageBlock` 的字段要求。

### 7.4 caption 服务

**入队**：首 chunk 后，对每个 `pending` 按 `captionKey` 去重入队（全局 Map 去重 + 状态缓存检查）。

**执行一张图**：

1. 检查 `state.getCaption(captionKey)`；命中直接返回。
2. 检查失败冷却 `state.failures[captionKey]`。
3. 路由：配置非空用配置，否则用触发请求的 `provider/model`。
4. `const call = await llm.prepareCall({ provider, model, maxTokens }, signal)`。
5. 能力检查：`call.inputModalities` 明确不含 `image` → 记 `no-image-modality` 失败，结束。
6. 构造消息：`createUserMessage({ content: [{ type: 'text', text: prompt }, { type: 'image', attachment: ref }], source: { kind: 'user' } })`。运行时 source.kind 可以是任意字符串，但用 `user` 不需要扩展 `MessageSourceMap` 类型。
7. `const options = { ...call.config, messages, system, sessionId, purpose: 'image-reference-caption', signal }`。
8. 用 `BlockAssembler` 收集 `call.stream(options)`，只取 text block。
9. 清洗：trim、去代码围栏、截断 `maxChars`。
10. 写入 `state.putCaption(captionKey, ...)`；成功日志。
11. 失败：`state.markFailure(captionKey, reason)`；按 `retries` 重试，退避 1s/4s。

**并发**：全局信号量 `caption.concurrency`；同一 `captionKey` 永不并发。

**超时**：`AbortSignal.timeout(timeoutMs)`；超时按失败处理。

**prompt**：见附录 B；`style` / `language` / `maxChars` 注入。

### 7.5 thumbnail 服务

**入队**：首 chunk 后，按 `thumbKey` 去重入队（仅 `features.thumbnail && capabilities.supportsImage`）。

**执行一张图**：

1. 命中 `state.getThumb` → 返回。
2. `const dims = longEdgeDimensions(ref.width, ref.height, longEdge)`（从 `@deepseek-ai/dsh-attachment` 导入）。
3. `const request = await attachments.readImageRequest(ref, { width: dims.width, height: dims.height, maxBytes }, signal)`。
4. `const thumbRef = await attachments.saveImage({ data: request.data, mediaType: request.mediaType, name: 'image-reference-thumb' })`。
5. `state.putThumb(thumbKey, thumbRef)`。

**注意事项**

- `readImageRequest` 是确定性缓存：同样的 target 重复调用不会重复编码。
- `saveImage` 会做归一化与校验；返回的 ref 是持久化对象（content-addressed），当前 DSH 没有自动 retention/cleanup，会一直占磁盘（每张约 10–60 KB）。
- 生成失败（格式不支持、配额、磁盘）→ 记失败，回退 caption/path，不影响主请求。

### 7.6 路径解析

```js
const access = resolveImageAttachmentAccess(
  attachments,
  hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath),
  ref,
)
```

- 来自 `@deepseek-ai/dsh-llm/content.ts` 的公开导出，和 DSH 原生占位文本同一条链路。
- 拿不到 `access` 时，文本写「no local path available; re-attach if needed」。
- 每次请求现算（执行世界可能变化），不缓存路径字符串。

### 7.7 能力检测

- 目标：判断当前 route 是否接受图片输入（决定 thumbnail 是否可用）。
- 方式：`const call = await llm.prepareCall({ provider, model }, signal)`；读 `call.inputModalities`。
- 语义：`undefined` = 未声明 → 保守视为不支持（thumbnail 回退）；明确包含 `image` → 支持；明确不含 → 不支持。
- 缓存：`Map<`${provider}/${model}`, { supported, at }>`，TTL 10 分钟。
- 超时 2 秒，失败不抛，视为 unknown。
- 注意：`prepareCall` 会创建 one-shot 句柄但不 dispatch，不消耗模型配额。

### 7.8 并发、失败、日志

- caption / thumbnail 是**完全后台**的：不 await、不阻塞请求、不进入 agent 的流。
- 每个队列有界（最多 200 个待处理；超出丢弃并打 warn），避免批量贴图打爆进程。
- 插件任何内部异常都不得让请求失败；最坏情况是「没生效，图片照常内联」。
- 日志前缀 `[image-reference]`；`summary` 级别只打关键事件。

---

## 8. 接口清单

### 8.1 依赖的 DSH 服务与 API

| 依赖 | 位置（0.2.2-rc.5） | 用途 | 状态 |
|---|---|---|---|
| `ctx.llm.adapters`（Map） | `dsh-llm/src/index.ts:370` | 就地包裹 adapter | ✅ |
| `llm/adapters-updated` | `dsh-llm/src/index.ts:386` | 重新扫描包裹 | ✅ |
| `adapter.prepareCall` / `PreparedAdapterCall{model,stream}` | `dsh-llm/src/index.ts:305`、`:210` | 包裹执行入口 | ✅ |
| `ctx.llm.prepareCall(config, signal, configure)` | `dsh-llm/src/index.ts:975` | caption 请求 + 能力查询 | ✅ |
| `ctx.llm.stream(options)` | `dsh-llm/src/index.ts:1185` | 备用辅助请求入口 | ✅ |
| `GenerateOptions.purpose/sessionId` | `dsh-llm/src/types.ts:599-605` | 辅助请求标记 | ✅ |
| `ImageBlock.offloaded` | `dsh-llm/src/types.ts:95` | 识别原生 offload | ✅ |
| `resolveImageAttachmentAccess` | `dsh-llm/src/content.ts:35` | 路径解析 | ✅ |
| `createUserMessage` / `BlockAssembler` | `dsh-llm/src/message.ts:246`、`assembler.ts:38` | caption 消息与流拼装 | ✅ |
| `attachments.readImageRequest` | `dsh-attachment/src/index.ts:277` | 生成缩略图字节 | ✅ |
| `attachments.saveImage` | `dsh-attachment/src/index.ts:186` | 持久化缩略图 | ✅ |
| `attachments.imageHostPath` | `dsh-attachment/src/index.ts:203` | 原图宿主路径 | ✅ |
| `longEdgeDimensions` | `dsh-attachment/src/request-projection.ts` | 等比缩略尺寸 | ✅ |
| `ctx.get('fs').processPathFromHostPath` | `dsh-fs/src/index.ts:169` | 宿主路径 → 执行世界路径 | ✅ |
| `plugins.row.config` 槽 | `dsh-client-ui-plugin-manager/lib/client.js` | v0.1 设置卡片 | ✅ |
| `@deepseek-ai/schemastery` | profile 依赖 | 配置 schema | ✅ |

### 8.2 内部模块与导出签名

```
lib/config.js
  export const Config
  export function resolveConfig(raw) -> ResolvedConfig
  export function appliesTo(config, provider, model) -> boolean
  export function captionKeyOf(attachmentId, cfg) -> string
  export function thumbKeyOf(attachmentId, cfg) -> string

lib/state.js
  export class StateStore {
    constructor(file, limits)
    load(): void                         // 同步；损坏时备份并重建
    isSent(key): boolean
    markSent(keys: string[]): void
    getCaption(key): CaptionEntry | undefined
    putCaption(key, entry): void
    getThumb(key): ImageAttachmentRef | undefined
    putThumb(key, ref): void
    isCooling(key, cooldownMs, now): boolean
    markFailure(key, reason): void
    flush(): void                        // 原子写
    stats(): { sent, captions, thumbs, bytes }
    clearCaches(kind): void              // v0.1 设置页用
  }

lib/projection.js
  export function hasImageDeep(content): boolean
  export function occurrenceKey(scope, message, path, block): string
  export function projectMessages(messages, env) -> { messages, pending, replaced }

lib/text.js
  export function buildReplacementText(ref, opts) -> string
  export function buildCaptionPrompt(style, language, maxChars, custom): { system, user }

lib/caption.js
  export class CaptionService {
    constructor({ llm, config, state, logger, now, signal })
    enqueue(task: { key, ref, provider, model, sessionId }): void
    drain(): Promise<void>              // 测试用
    stats(): { queued, running, ok, failed }
  }

lib/thumbnail.js
  export class ThumbnailService {
    constructor({ attachments, config, state, logger })
    enqueue(task: { key, ref }): void
    drain(): Promise<void>
    stats(): { queued, running, ok, failed }
  }

lib/capabilities.js
  export class CapabilityCache {
    constructor({ llm, ttlMs, timeoutMs })
    supportsImage(provider, model): boolean   // 同步读缓存
    ensure(provider, model): Promise<void>    // 异步填充
  }

lib/index.js
  export const name = 'dsh-image-reference'
  export const inject = ['llm', 'attachments']
  export const Config = ...             // 从 config.js 转出
  export function apply(ctx, config = {}): void

lib/client.js
  // 平台闭包工厂（window.__ModuleLoader__.load），无导出；
  // 在 plugins.row.config 注册 key = dsh-image-reference#image-reference 的卡片
```

### 8.3 配置接口

见第 5 节。schemastery 草案：

```js
export const Config = z.object({
  features: z.object({
    caption: z.boolean().default(true),
    thumbnail: z.boolean().default(true),
    minImages: z.number().step(1).min(1).max(50).default(1),
  }).default({ caption: true, thumbnail: true, minImages: 1 }).volatile(),
  providers: z.dict(z.object({
    enabled: z.boolean().default(true),
    models: z.array(z.string()).default([]),
  })).default({}).volatile(),
  caption: z.object({
    provider: z.string().default(''),
    model: z.string().default(''),
    style: z.union(['structured', 'brief', 'ocr']).default('structured'),
    language: z.union(['en', 'zh', 'auto']).default('en'),
    maxChars: z.number().step(1).min(80).max(2000).default(400),
    maxTokens: z.number().step(1).min(0).max(2048).default(0),
    concurrency: z.number().step(1).min(1).max(8).default(2),
    timeoutMs: z.number().step(1).min(1000).max(300000).default(60000),
    retries: z.number().step(1).min(0).max(3).default(1),
    cooldownMs: z.number().step(1).min(0).default(600000),
    prompt: z.string().default(''),
  }).default({}).volatile(),
  thumbnail: z.object({
    longEdge: z.number().step(1).min(64).max(1024).default(320),
    maxBytes: z.number().step(1).min(4096).max(1048576).default(65536),
    concurrency: z.number().step(1).min(1).max(4).default(1),
  }).default({}).volatile(),
  state: z.object({
    persist: z.boolean().default(true),
    scope: z.union(['profile', 'home']).default('profile'),
    path: z.string().default(''),
    clearToken: z.number().default(0),
    maxOccurrences: z.number().step(1).min(100).default(20000),
    maxEntries: z.number().step(1).min(100).default(10000),
  }).default({}).volatile(),
  log: z.union(['off', 'summary', 'verbose']).default('summary').volatile(),
})
```

> `.default({})` 在 schemastery 里对嵌套对象通常表示「缺省时用子字段默认值」；实现时用实际 schemastery 版本验证一次。

### 8.4 持久化接口

见 6.1。对外只暴露 `StateStore` 的方法；文件格式版本化（`version: 1`），未来迁移在 `load` 里处理。

### 8.5 客户端接口（v0.1 交付）

- 挂载：`plugins.row.config`，key = `dsh-image-reference#image-reference`。
- 卡片内容：
  - 三个控件：文字描述开关、缩略图开关、接管阈值 `minImages`（数字输入，1–50）。
  - 描述路由：provider 下拉（`remote.llm.listProviders()` + `listConfigurableProviders()` 合并）+ model 输入；空 = 跟随。
  - 风格下拉（structured / brief / ocr）与语言下拉（en / zh / auto）。
  - 状态文件：显示当前路径；`scope` 切换（profile / home）。
  - 缓存统计（已描述图片数、缩略图数、state 大小）+ 清空按钮。
  - 版本横幅：当前 DSH 不是 0.2.x 时显示「不受支持」。
- 清空实现：设置页写入一个 volatile 触发器（如 `state.clearToken = Date.now()`），宿主监听配置变化后清空内存与文件；若路径不可写则只显示提示，不报错。
- 复用 image-once 的 token 白名单与手写 bundle 模式（`window.__ModuleLoader__.load({id, factory})`，无构建步骤）。

---

## 9. 时序

### 首次请求（图片第一次出现）

```
loop ─ request(含 image) ─▶ wrapper.dispatch
                              ├─ purpose? no; hasImage? yes
                              ├─ await ensureCapabilities(provider, model)   [2s 上限]
                              ├─ projectMessages: image 未发送 → 原样保留, pending=[key]
                              ├─ stream = inner.stream(改写后的 messages)
                              └─ for await chunk:
                                    ├─ 第一个 chunk → state.markSent(pending)
                                    │                captionQueue.enqueue(...)
                                    │                thumbQueue.enqueue(...)
                                    └─ yield chunk
loop ◀ chunks
```

### 后续请求

```
loop ─ request(含同一 image) ─▶ wrapper.dispatch
                                  ├─ projectMessages: key 已发送
                                  │    ├─ thumb 命中且支持图 → image(thumb) + text(path+caption?)
                                  │    └─ 否则 → text(path+caption?)
                                  ├─ inner.stream(改写后的 messages)
                                  └─ yield chunks（无 pending，不记账）
```

### 后台 caption

```
queue ─▶ prepareCall({provider, model, maxTokens})
      ─▶ inputModalities 检查
      ─▶ stream({ messages:[user(text+image)], system, purpose:'image-reference-caption' })
      ─▶ 收集 text → 清洗/截断 → state.putCaption
      ─▶ 失败 → markFailure → 退避重试（最多 retries 次）
```

---

## 10. 兼容性与版本

- 目标：DSH `0.2.2-rc.5`；**只兼容 0.2.x**。
- `package.json` 写 `engines.dsh: ">=0.2.0-0 <0.3.0"`：DSH 0.3 安装/激活时会直接拒绝并提示版本不兼容；`peerDependencies` 里的 `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-attachment` 也写同一范围。
- 运行时再读一次 DSH 安装目录的 `package.json` 版本：主版本不是 0.2 时打 warn，并在设置页卡片顶部显示「当前 DSH 版本不受支持」的横幅（插件仍可卸载/关闭）。
- `package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml` 插入一行 `id: image-reference`。
- 客户端半体沿用 image-once 的 `window.__ModuleLoader__.load({id, factory})` 形式，无构建步骤。
- 插件在 profile 里是 linked 形态：host 半体 `import` 的 bare specifier（`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-attachment`）必须出现在 `package.json` 的 `peerDependencies`，否则 `routeLinked` 解析不到。
- 改动 `lib/*.js`、`cordis.patch.yml`、`package.json` 后要**整包重启 DSH**（ESM 模块缓存），不能只靠热重放。

---

## 11. 风险与边界

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| 1 | 描述可能不准确/幻觉 | 模型基于错误描述推理 | 占位文本标注「自动生成，可能不准确」；保留原图路径；`ocr` 风格要求「看不清就说明」 |
| 2 | 额外成本 | 每张图一次视觉调用 | 默认跟随当前模型；可指定廉价 vision 模型；可关 caption；失败冷却 |
| 3 | 隐私面扩大 | 图片多发给一个 provider | 默认跟随当前 provider（不新增接收方）；文档提示；可关 caption |
| 4 | 描述延迟 | 第一次后续请求可能只有路径 | 回退链 + 下次补上；不阻塞主请求 |
| 5 | prompt cache 失效 | 该图之后的前缀缓存失效一次 | 与 image-once/原生 offload 同代价；无法避免 |
| 6 | 与 image-once 冲突 | 双重改写 | 检测并禁用自己；文档写明互斥 |
| 7 | 磁盘增长 | state + 缩略图对象 | `maxOccurrences`/`maxEntries`；缩略图小；文档提示 |
| 8 | DeepSeek Files API 配额 | caption 请求走 file 上传 | 单图小；失败冷却；可换 provider |
| 9 | `inputModalities` 未声明 | thumbnail 不生效 | 保守回退；可在 provider 配置里声明图片能力 |
| 10 | 插件 bug 阻断会话 | 不能用 | 全链路 fail-open；只包改写段，不吞 adapter 错误 |
| 11 | 缩略图对象被未来清理 | thumbnail 失效 | 回退 caption/path；启动时校验一次可读 |
| 12 | 状态文件损坏 | 历史图重发 | 备份 + 重建；原子写 |
| 13 | 会话中途切 provider/model | 能力不同 | 能力按 provider/model 缓存；thumbnail 可能回退 |
| 14 | request-only user input 无 id | key 不稳定 | 用 `#path` 回退；这类消息一般不参与历史记账 |
| 15 | DSH 大版本升级（0.3+） | 内部函数签名变化，插件不可用 | `engines.dsh` 拒绝安装/激活；设置页标注不兼容；升级时再适配 |

**明确不做**：

- 不修改 DSH 源码。
- 不写回会话日志。
- 不注册新 provider。
- 不处理 assistant/system 里的图片。
- 不做图片编辑/裁剪（缩略图只走 attachment 服务的请求变体）。

---

## 12. 测试计划

### 12.1 单元测试（`node:test`，不依赖 DSH 运行时）

`test/projection.test.mjs`

1. 首次出现：原图保留，pending 正确。
2. 已发送：替换成 text，块顺序不变。
3. `[text:A, image, text:B]` → 不丢 text:B。
4. `[image, text]` → 不丢 text。
5. `tool-result` 嵌套图片：递归替换。
6. `offloaded: true`：不进入 pending，直接替换。
7. 同一消息内同图多次：pending 去重；key 按 path 区分。
8. 未改动的消息返回原对象。
9. caption 命中/未命中；thumbnail 命中/未命中；回退链四种组合。
10. 路径缺失时的文案。

`test/state.test.mjs`

1. 原子写、重启读回。
2. 损坏 JSON → 备份 + 重建。
3. LRU 淘汰。
4. 并发 markSent / putCaption 不丢数据。
5. `persist=false` 不落盘。

`test/caption.test.mjs`（mock llm）

1. 成功：收集 text、截断、写缓存。
2. 模型无 image modality → 记失败，不重试。
3. 超时 → 重试 → 冷却。
4. 同一 captionKey 并发去重。
5. 全局并发上限。
6. prompt 自定义覆盖。

`test/thumbnail.test.mjs`（mock attachments）

1. 成功：readImageRequest → saveImage → 缓存 ref。
2. `longEdgeDimensions` 只缩不放。
3. 失败回退。
4. 同一 thumbKey 去重。

`test/config.test.mjs`

1. 默认值。
2. provider 匹配（enabled/models）。
3. 只填 provider 或 model 一个 → 跟随。

### 12.2 集成测试（fake adapter）

- 构造 wrapper + fake adapter + fake state，跑一次 dispatch：
  - 断言内层收到的 messages 形状（text/image/text 顺序、描述内容）。
  - 断言首 chunk 前不记账、首 chunk 后记账。
  - 断言 purpose 请求直通。
  - 断言内层抛错不被吞。

### 12.3 真实环境验收（需要用户配合）

1. 临时 profile 安装，重启，日志出现 `[image-reference] wrapped N provider(s)`。
2. 贴一张截图，第一轮请求正常。
3. 第二轮请求（同一会话）日志/调试输出显示该图被替换为 `[image omitted ... description ...]`。
4. `state.json` 出现 caption 记录。
5. 重启 DSH，同一会话再发一轮：历史图不再重发（sent 持久化生效）。
6. 断网/关 caption 模型：仍能正常发送，只有路径文本。
7. 大图（>1 MiB）与多图（5 张）各跑一次。

---

## 13. 分阶段实施

| 阶段 | 内容 | 产出 | 预估 |
|---|---|---|---|
| P1 | `config` + `projection` + `state` + `text` + 单测 | 纯函数层可测 | 1 天 |
| P2 | `caption` + `thumbnail` + `capabilities` + mock 单测 | 后台服务可测 | 1 天 |
| P3 | `index.js` 装配（adapter 包裹、fail-open、日志） | 可安装的 host 插件 | 1 天 |
| P4 | 客户端设置卡片（开关、接管阈值、模型、风格、语言、清缓存） | 设置页可用 | 1 天 |
| P5 | 真实环境安装/重启/验收 + README | v0.1 交付 | 0.5 天 |

**v0.1 验收标准**：单测全绿；临时 profile 安装成功；设置页可改开关/阈值/模型且即时生效；首次请求原图、第二次请求替换为路径/描述；状态持久化；失败回退不阻断会话。

---

## 14. 已确认决策（2026-11-26）

1. **设置页**：v0.1 就交付设置页卡片（开关、阈值、模型、风格、语言、清缓存）；YAML 仍可用。
2. **名称**：`dsh-image-reference`，中文「图片引用」。
3. **描述语言**：默认 `en`，可切 `zh` / `auto`（跟随图片里的文字语言）。
4. **接管时机**：默认 `minImages = 1`（每张图发过一次就接管）；可配置从第 N 张图开始接管。
5. **状态文件**：默认放当前 profile 专属目录 `~/.dsh/profiles/web/image-reference/state.json`；可切换为全局 `~/.dsh/image-reference/`。
6. **依赖**：借用 `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-attachment` 的公开函数；`engines.dsh` 限制 `>=0.2.0-0 <0.3.0`，0.3+ 标注不兼容并拒绝激活。

**实现前仍需在代码中验证的技术点**：

- schemastery 的 `.default({}).volatile()` 组合在本机版本上的实际行为。
- 设置页写入 `features.minImages` 等路径时，`isVolatilePath` 是否接受。
- 缩略图 `saveImage` 对象在重启后仍可读；启动时后台校验，失效则剔除缓存。
- 设置页卡片的 token 白名单与零颜色字面量门禁（沿用 image-once 的测试）。

---

## 附录 A：占位文本模板

### A.1 path（en，默认）

```
[image omitted from this request to save size; attachment sha256:abcd1234 (1920x1080px, image/png). Read-only local copy: "C:\Users\...\attachments\v1\objects\ab\abcd...". Use read_image on that path if exact pixels are needed.]
```

无路径时：

```
[image omitted from this request to save size; attachment sha256:abcd1234 (1920x1080px, image/png). No local read-only path is available; ask the user to re-attach it if needed.]
```

### A.2 caption

```
[image omitted from this request to save size; attachment sha256:abcd1234 (1920x1080px, image/png). Read-only local copy: "...".
Auto-generated description (may be inaccurate; use read_image for exact details):
<caption text>
]
```

### A.3 thumbnail + caption

image block 之后紧跟：

```
[thumbnail of attachment sha256:abcd1234 (1920x1080px, image/png); full-resolution read-only copy: "...".
Auto-generated description (may be inaccurate): <caption text>
]
```

### A.4 zh / auto 变体

- `zh`：把模板文字翻成中文，不改 attachmentId / 路径 / `read_image` 名称（模型调用的是工具名，不翻译）。
- `auto`：模板语言跟随 caption 的语言（由描述模型按图中主要文字判断），仅在 `language: auto` 时使用。

---

## 附录 B：caption prompt

### B.1 system

```
You describe images for a coding agent. A future request will see only your description and a local path, not the image itself. Describe what a competent engineer needs to know:

1. What it is: screenshot, photo, diagram, chart, UI, code, error, document, etc.
2. Text: transcribe visible text, code, error messages, table cells, and labels as exactly as you can. If text is too small or blurred, say so instead of guessing.
3. Structure: UI regions, panes, buttons, layout, selected state, colors only when they carry meaning.
4. Data: numbers, axes, legends, timestamps, filenames that are visible.

Rules:
- Be factual. Do not speculate about things not visible.
- Do not add advice, fixes, or next steps.
- Output only the description, no preamble, no markdown fences.
- Keep it under {maxChars} characters.
```

### B.2 style 变体

- `structured`：按「画面 / 文字 / 关键元素」三段输出（允许短标签）。
- `brief`：一句话，≤ `min(maxChars, 160)`。
- `ocr`：先尽量抄全文字，再用一句话说画面。

### B.3 user

```
Describe this image.
```

（图片作为同一 user 消息的 image block 紧跟在 text 后。）

---

## 附录 C：关键源码位置（0.2.2-rc.5）

- `dsh-llm/src/index.ts:370` — `adapters = new Map`
- `dsh-llm/src/index.ts:386` — `llm/adapters-updated` 分发
- `dsh-llm/src/index.ts:975` — `prepareCall`
- `dsh-llm/src/index.ts:1185` — `stream`
- `dsh-llm/src/types.ts:95` — `ImageBlock.offloaded`
- `dsh-llm/src/types.ts:599-605` — `sessionId` / `purpose`
- `dsh-llm/src/content.ts:35` — `resolveImageAttachmentAccess`
- `dsh-llm/src/content.ts:109` — `offloadedImageText`（固定文案，故不能复用）
- `dsh-llm/src/message.ts:246` — `createUserMessage`
- `dsh-llm/src/assembler.ts:38` — `BlockAssembler`
- `dsh-attachment/src/index.ts:186` — `saveImage`
- `dsh-attachment/src/index.ts:203` — `imageHostPath`
- `dsh-attachment/src/index.ts:277` — `readImageRequest`
- `dsh-attachment/src/types.ts:142` — `ImageRequestTarget`
- `dsh-attachment/src/types.ts:152` — `RequestImageAttachment`
- `dsh-attachment/src/types.ts:127` — `SaveImageAttachment`
- `dsh-fs/src/index.ts:169` — `processPathFromHostPath`
- `dsh-session-title-llm/src/index.ts:258-284` — 辅助请求范例（prepareCall + purpose + BlockAssembler）
- `dsh-client-ui-plugin-manager/lib/client.js` — `plugins.row.config` / `rowConfigKey`
