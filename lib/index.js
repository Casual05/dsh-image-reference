import { BlockAssembler, createUserMessage, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { installImageReference } from './runtime.js'

export { Config } from './schema.js'

export const name = 'dsh-image-reference'
export const inject = ['llm', 'attachments']

export function apply(ctx, config = {}) {
  return installImageReference(ctx, config, { BlockAssembler, createUserMessage, resolveImageAttachmentAccess })
}
