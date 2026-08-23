# H-Chat API contract

Base URL: `https://internal-apigw-kr.hmg-corp.io/hchat-in/api/v3` (referred to as `{base}` below)

All chat endpoints take header:
```
Authorization: <HCHAT_KEY>
Content-Type: application/json
```
No `Bearer ` prefix. (The unrelated `{base}/usage/external/personal?year=&month=&day=` usage-stats
endpoint is the one place that *does* want `Authorization: Bearer <key>` — not needed for chat calls.)

Smoke test before writing app code:
```bash
curl -s "$BASE/claude/messages" \
  -H "Authorization: $HCHAT_KEY" -H "Content-Type: application/json" \
  -d '{"model":"claude-sonnet-5","max_tokens":50,"stream":false,"messages":[{"role":"user","content":"ping"}]}'
```

---

## Claude — Anthropic Messages API shape

`POST {base}/claude/messages`

Request body (identical to Anthropic's native Messages API):
```json
{
  "model": "claude-sonnet-5",
  "max_tokens": 16000,
  "stream": false,
  "system": "optional system prompt string",
  "messages": [{ "role": "user", "content": "..." }]
}
```
- `content` may be a string or a content-block array (text/image blocks) same as native Anthropic API.
- `messages` roles are `user` / `assistant` only — no `system` role in the array, use the top-level `system` field.

Non-streaming response:
```json
{ "content": [{ "type": "text", "text": "..." }], "...": "rest matches Anthropic Messages API response" }
```
Read the answer as `data.content[0].text`.

### Streaming (`stream: true`)
Standard SSE. Each event is a line `data: <json>` (blank line between events), terminated by a literal
`data: [DONE]` line. Parse each JSON payload's `type`:
- `content_block_delta` with `delta.type === "text_delta"` → append `delta.text` to the running answer
- `message_stop` → stream is done, stop reading
- `error` → payload has `error.message`; treat as fatal, stop reading and surface the message
- any other `type` (e.g. `message_start`, `content_block_start`, `ping`) → ignore

Malformed/incomplete JSON on a line (partial chunk boundary) should be skipped, not thrown — buffer by `\n`
and only parse complete lines.

---

## ChatGPT — Azure-OpenAI-style deployment routing

`POST {base}/openai/deployments/{model}/chat/completions`

The model id is a **path segment** ("deployment name"), not a body field.

Request body:
```json
{
  "stream": false,
  "messages": [{ "role": "user", "content": "..." }],
  "max_completion_tokens": 2000
}
```
- Standard OpenAI chat message roles: `system` / `user` / `assistant`, `content` is a plain string.
- Use `max_completion_tokens`, not `max_tokens`.

Non-streaming response: standard OpenAI chat-completion shape —
`data.choices[0].message.content`.

### Streaming (`stream: true`)
Standard OpenAI-style SSE: lines `data: <json>` with
`json.choices[0].delta.content` holding each incremental text chunk, terminated by literal `data: [DONE]`.

---

## Gemini — `models/{model}:generateContent`

`POST {base}/models/{model}:generateContent` (non-streaming)
`POST {base}/models/{model}:streamGenerateContent` (streaming)

Request body:
```json
{
  "contents": [
    { "role": "user", "parts": [{ "text": "..." }] }
  ],
  "generationConfig": { "maxOutputTokens": 2000 },
  "systemInstruction": { "parts": [{ "text": "optional system prompt" }] }
}
```
- No `system` role inside `contents` — use top-level `systemInstruction` instead.
- Assistant turns use `role: "model"` (not `"assistant"`) inside `contents`.

Non-streaming response: `data.candidates[0].content.parts[0].text`.

### Streaming (`:streamGenerateContent`)
**Not standard SSE.** The raw body is either NDJSON-ish (one JSON object per line) or a single JSON array
spread across lines, where continuation lines start with `,`. Practical parse loop:
1. Split the buffered response text on `\n`.
2. For each non-empty trimmed line: skip lone `[` / `]` lines; if the line starts with `,`, strip the
   leading comma; `JSON.parse` what remains.
3. Each parsed value is one `GenerateContentResponse` chunk (or an array of them) — walk
   `candidates[].content.parts[]` same as the non-streaming shape and accumulate `.text`.
4. Skip parts where `part.thought === true` (thinking-model "reasoning" parts, not the answer).

If a line fails to parse, skip it silently — it's usually a partial chunk boundary artifact, not corruption.

---

## Gemini image generation

Same `:streamGenerateContent` endpoint, with an image-capable model (e.g. `gemini-3.1-flash-image`).

Request body:
```json
{
  "contents": [
    { "role": "user", "parts": [
      { "inline_data": { "mime_type": "image/png", "data": "<base64 input image, optional>" } },
      { "text": "prompt describing the desired image / edit" }
    ]}
  ],
  "generationConfig": {
    "responseModalities": ["IMAGE", "TEXT"],
    "thinkingConfig": { "thinkingBudget": 0 }
  },
  "system_instruction": { "parts": [{ "text": "optional" }] }
}
```
Note the top-level field is `system_instruction` (snake_case) here, unlike the text endpoint's
`systemInstruction` (camelCase) — the gateway is inconsistent between the two; match exactly as shown.

Response parts may key the inline result as either `inlineData` or `inline_data` (both appear in the wild
depending on API version) — check both:
```
part.inlineData ?? part.inline_data → { data: "<base64>", mimeType: "image/png" }
```
Skip any part with `thought: true`. If no image part is found across the whole stream, treat it as an error
and include the first ~500 chars of the raw response in the error message for debugging — the gateway
sometimes returns a plain error/quota JSON body instead of image chunks.

---

## Error handling conventions worth copying

- Always check `res.ok` before parsing JSON; on failure, read the body as text (bounded, e.g. first 200-500
  chars) and include the HTTP status in the thrown error — H-Chat error bodies are small and worth surfacing
  directly rather than swallowing.
- For streaming Claude specifically, a `type: "error"` SSE event can arrive *after* `res.ok` was true (the
  gateway returns HTTP 200 and starts streaming, then emits an error event mid-stream) — treat it as fatal
  the same as a non-2xx response.
