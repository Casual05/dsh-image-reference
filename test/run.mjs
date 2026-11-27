/**
 * 测试入口：用 node --test 跑全部单测。
 * 单独用 run.mjs 是为了跨平台（Windows 下 npm 的 * 通配不会展开）。
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const directory = new URL('./', import.meta.url)
const files = readdirSync(directory)
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => fileURLToPath(new URL(name, directory)))

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
process.exit(result.status ?? 1)
