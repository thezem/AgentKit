import type { AttachmentRef } from '../capsules/shared/contract.ts'

/**
 * Attachments ride in the prompt as one trailing tag, so every provider (and its own history replay)
 * keeps them. Browser-safe: no `node:*` imports. Ships as `@ouim/agentkit/attachment-tags`.
 *
 *   <attachments note="…">
 *   <file name="spec.pdf" path="/…/spec.pdf" type="application/pdf" size="48213"/>
 *   </attachments>
 */
const NOTE = 'Files the user attached to this message. Read them from path with your file tools; images may also be attached inline.'
// Capsules may render inline image blocks after the text as `[image]` lines; tolerate them.
const BLOCK = /\s*<attachments(?: [^>]*)?>\n([\s\S]*?)\n<\/attachments>(?:\s*\[image\])*\s*$/
const FILE = /<file name="([^"]*)" path="([^"]*)" type="([^"]*)" size="(\d+)"\/>/g

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unesc = (value: string) => value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/** The tag appended to the text sent to the model (empty string for no attachments). */
export function attachmentsTag(refs: AttachmentRef[]): string {
  if (!refs.length) return ''
  const files = refs.map((ref) => `<file name="${esc(ref.name)}" path="${esc(ref.path)}" type="${esc(ref.mimeType)}" size="${ref.size}"/>`)
  return `\n\n<attachments note="${NOTE}">\n${files.join('\n')}\n</attachments>`
}

/** Split a sent message back into the text the user typed and its attachments. */
export function splitAttachments(text: string): { text: string; attachments: AttachmentRef[] } {
  const match = BLOCK.exec(text)
  if (!match) return { text, attachments: [] }
  const attachments = [...match[1].matchAll(FILE)].map((m) => ({ name: unesc(m[1]), path: unesc(m[2]), mimeType: unesc(m[3]), size: Number(m[4]) }))
  return { text: text.slice(0, match.index), attachments }
}
