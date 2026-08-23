/**
 * H-Chat API client — thin fetch wrapper for Claude / ChatGPT / Gemini via HMG's internal gateway.
 * Dependency-free (global fetch only). Node 18+ / Next.js / Vite / etc.
 *
 * Setup: set HCHAT_KEY in the environment, or pass `apiKey` explicitly to any call.
 * Key issuance: https://h-chat-platform.autoever.com/personal-key-lists (expires in 90 days)
 *
 * See reference.md in this skill for the full per-provider request/response contract.
 */

const HCHAT_BASE_URL = 'https://internal-apigw-kr.hmg-corp.io/hchat-in/api/v3'

function getHeaders(apiKey?: string): Record<string, string> {
  const key = apiKey ?? process.env.HCHAT_KEY ?? ''
  if (!key) throw new Error('HCHAT_KEY is not set (env var or apiKey param)')
  return { 'Content-Type': 'application/json', Authorization: key }
}

type ChatMessage = { role: 'user' | 'assistant' | 'system'; content: string | unknown[] }

// ───────────────────────── Claude ─────────────────────────

export async function claudeOnce(
  messages: ChatMessage[],
  options: { model?: string; maxTokens?: number; system?: string; apiKey?: string } = {},
): Promise<string> {
  const res = await fetch(`${HCHAT_BASE_URL}/claude/messages`, {
    method: 'POST',
    headers: getHeaders(options.apiKey),
    body: JSON.stringify({
      model: options.model ?? 'claude-sonnet-5',
      max_tokens: options.maxTokens ?? 2000,
      stream: false,
      ...(options.system ? { system: options.system } : {}),
      messages,
    }),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`H-Chat Claude error (${res.status}): ${errText.slice(0, 200)}`)
  }
  const data = (await res.json()) as { content?: { text?: string }[] }
  return data.content?.[0]?.text?.trim() ?? ''
}

export async function claudeStream(
  messages: ChatMessage[],
  options: { model?: string; maxTokens?: number; system?: string; apiKey?: string } = {},
): Promise<Response> {
  return fetch(`${HCHAT_BASE_URL}/claude/messages`, {
    method: 'POST',
    headers: getHeaders(options.apiKey),
    body: JSON.stringify({
      model: options.model ?? 'claude-sonnet-5',
      max_tokens: options.maxTokens ?? 16000,
      stream: true,
      ...(options.system ? { system: options.system } : {}),
      messages,
    }),
  })
}

/** Reads a claudeStream() Response body to completion and returns the concatenated text. */
export async function collectClaudeStreamText(res: Response): Promise<string> {
  if (!res.body) throw new Error('No response body to stream')
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = done ? '' : (lines.pop() ?? '')
    let stop = false
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (payload === '[DONE]') { stop = true; break }
      let evt: { type?: string; error?: { message?: string }; delta?: { type?: string; text?: string } }
      try {
        evt = JSON.parse(payload)
      } catch {
        continue
      }
      if (evt.type === 'error') {
        reader.cancel().catch(() => {})
        throw new Error(evt.error?.message ?? 'H-Chat error')
      }
      if (evt.type === 'message_stop') { stop = true; break }
      if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
        text += evt.delta.text ?? ''
      }
    }
    if (done || stop) {
      reader.cancel().catch(() => {})
      break
    }
  }
  return text
}

// ───────────────────────── ChatGPT ─────────────────────────

export async function chatgptOnce(
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
  options: { model?: string; maxTokens?: number; apiKey?: string } = {},
): Promise<string> {
  const model = options.model ?? 'gpt-5.6-terra'
  const res = await fetch(`${HCHAT_BASE_URL}/openai/deployments/${model}/chat/completions`, {
    method: 'POST',
    headers: getHeaders(options.apiKey),
    body: JSON.stringify({ stream: false, messages, max_completion_tokens: options.maxTokens ?? 2000 }),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`H-Chat ChatGPT error (${res.status}): ${errText.slice(0, 200)}`)
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] }
  return data.choices?.[0]?.message?.content?.trim() ?? ''
}

export async function chatgptStream(
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
  options: { model?: string; maxTokens?: number; apiKey?: string } = {},
): Promise<Response> {
  const model = options.model ?? 'gpt-5.6-terra'
  return fetch(`${HCHAT_BASE_URL}/openai/deployments/${model}/chat/completions`, {
    method: 'POST',
    headers: getHeaders(options.apiKey),
    body: JSON.stringify({ stream: true, messages, max_completion_tokens: options.maxTokens ?? 16000 }),
  })
}

// ───────────────────────── Gemini (text) ─────────────────────────

function toGeminiContents(messages: { role: 'user' | 'assistant' | 'system'; content: string }[]) {
  return messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
}

export async function geminiTextOnce(
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
  options: { model?: string; maxTokens?: number; system?: string; apiKey?: string } = {},
): Promise<string> {
  const model = options.model ?? 'gemini-3.6-flash'
  const sys = options.system ?? messages.find((m) => m.role === 'system')?.content
  const body: Record<string, unknown> = {
    contents: toGeminiContents(messages),
    generationConfig: { maxOutputTokens: options.maxTokens ?? 2000 },
    ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
  }
  const res = await fetch(`${HCHAT_BASE_URL}/models/${model}:generateContent`, {
    method: 'POST',
    headers: getHeaders(options.apiKey),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`H-Chat Gemini error (${res.status}): ${errText.slice(0, 200)}`)
  }
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] }
  return data.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? ''
}

export async function geminiTextStream(
  messages: { role: 'user' | 'assistant' | 'system'; content: string }[],
  options: { model?: string; maxTokens?: number; system?: string; apiKey?: string } = {},
): Promise<Response> {
  const model = options.model ?? 'gemini-3.6-flash'
  const sys = options.system ?? messages.find((m) => m.role === 'system')?.content
  const body: Record<string, unknown> = {
    contents: toGeminiContents(messages),
    generationConfig: { maxOutputTokens: options.maxTokens ?? 65536 },
    ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}),
  }
  return fetch(`${HCHAT_BASE_URL}/models/${model}:streamGenerateContent`, {
    method: 'POST',
    headers: getHeaders(options.apiKey),
    body: JSON.stringify(body),
  })
}

/**
 * Parses a Gemini streamGenerateContent response body (NOT plain SSE — see reference.md)
 * and returns the concatenated text.
 */
export async function collectGeminiStreamText(res: Response): Promise<string> {
  const raw = await res.text()
  if (!res.ok) throw new Error(`H-Chat Gemini error (${res.status}): ${raw.slice(0, 200)}`)
  let text = ''
  for (const rawLine of raw.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed === '[' || trimmed === ']') continue
    const json = trimmed.startsWith(',') ? trimmed.slice(1) : trimmed
    try {
      const parsed = JSON.parse(json)
      const chunks = Array.isArray(parsed) ? parsed : [parsed]
      for (const chunk of chunks) {
        for (const candidate of chunk.candidates ?? []) {
          for (const part of candidate.content?.parts ?? []) {
            if (part.thought) continue
            if (typeof part.text === 'string') text += part.text
          }
        }
      }
    } catch {
      // partial chunk boundary — skip
    }
  }
  return text
}

// ───────────────────────── Gemini (image generation) ─────────────────────────

export type GeminiImageResult = { base64Data: string; mimeType: string }

export async function geminiGenerateImage(
  prompt: string,
  options: {
    model?: string
    systemInstruction?: string
    inlineImages?: { data: string; mimeType: string }[]
    apiKey?: string
  } = {},
): Promise<GeminiImageResult> {
  const model = options.model ?? 'gemini-3.1-flash-image'
  const imageParts = (options.inlineImages ?? []).map((img) => ({
    inline_data: { mime_type: img.mimeType, data: img.data },
  }))
  const body: Record<string, unknown> = {
    contents: [{ role: 'user', parts: [...imageParts, { text: prompt }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'], thinkingConfig: { thinkingBudget: 0 } },
    ...(options.systemInstruction ? { system_instruction: { parts: [{ text: options.systemInstruction }] } } : {}),
  }
  const res = await fetch(`${HCHAT_BASE_URL}/models/${model}:streamGenerateContent`, {
    method: 'POST',
    headers: getHeaders(options.apiKey),
    body: JSON.stringify(body),
  })
  const raw = await res.text().catch(() => '')
  if (!res.ok) throw new Error(`H-Chat Gemini image error (${res.status}): ${raw.slice(0, 500)}`)

  let base64Data = ''
  let mimeType = 'image/png'
  for (const rawLine of raw.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed || trimmed === '[' || trimmed === ']') continue
    const json = trimmed.startsWith(',') ? trimmed.slice(1) : trimmed
    try {
      const parsed = JSON.parse(json)
      const chunks = Array.isArray(parsed) ? parsed : [parsed]
      for (const chunk of chunks) {
        for (const candidate of chunk.candidates ?? []) {
          for (const part of candidate.content?.parts ?? []) {
            if (part.thought) continue
            const inline = part.inlineData ?? part.inline_data
            if (inline?.data) { base64Data = inline.data; mimeType = inline.mimeType ?? 'image/png' }
          }
        }
      }
    } catch {
      // partial chunk boundary — skip
    }
  }
  if (!base64Data) throw new Error(`No image data found\n\n[first 500 chars of raw response]\n${raw.slice(0, 500)}`)
  return { base64Data, mimeType }
}
