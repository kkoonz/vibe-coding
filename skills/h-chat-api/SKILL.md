---
name: h-chat-api
description: Use when a project needs to call Claude, ChatGPT, or Gemini through HMG(현대차그룹)/Autoever's internal "H-Chat" API gateway (internal-apigw-kr.hmg-corp.io/hchat-in). Trigger on mentions of "h-chat", "hchat", "H-CHAT", HCHAT_KEY, h-chat-platform.autoever.com, or requests to add/wire up Claude/ChatGPT/Gemini API calls in an internal HMG project without a direct Anthropic/OpenAI/Google API key. Do not use for direct (non-gateway) Anthropic/OpenAI/Google API integration — that's a different setup.
---

# H-Chat API

H-Chat is HMG/Autoever's internal API gateway that proxies to Claude, ChatGPT(Azure OpenAI), and Gemini
behind one endpoint and one personal API key, so internal projects don't need separate vendor keys or VPN/firewall
exceptions per provider.

- Base URL: `https://internal-apigw-kr.hmg-corp.io/hchat-in/api/v3`
- Key issuance: https://h-chat-platform.autoever.com/personal-key-lists (**expires in 90 days**)
- Auth: header `Authorization: <raw key>` — **no `Bearer ` prefix** for the chat endpoints (Claude/ChatGPT/Gemini).
  The separate `/usage/external/personal` usage-stats endpoint is the one exception and does want `Bearer <key>`.
- Recommended env var name: `HCHAT_KEY`

## Quick start

1. Get a key from the issuance URL above, put it in `.env` as `HCHAT_KEY=...`.
2. Copy `client.ts` from this skill into the target project (e.g. `lib/hchat.ts`) — it's dependency-free,
   just uses global `fetch`, and works in any Node 18+ / Next.js / Vite project.
3. Call `claudeOnce(...)`, `chatgptOnce(...)`, or `geminiTextOnce(...)` for a plain response, or the
   `*Stream` variants when you need to pipe an SSE/streaming response back to a browser.
4. Sanity-check the key works with a plain curl call before wiring up app code (see `reference.md`).

Read `reference.md` for the full request/response contract per provider (including streaming chunk formats,
Gemini's non-SSE NDJSON-ish stream shape, and image generation via Gemini) before implementing anything beyond
what `client.ts` already covers — don't guess at payload shapes, they differ meaningfully between the three
providers even though they're behind one gateway.

## Known-good model ids (as of 2026-08, verify against the platform — these roll forward)

| Provider | Example model id | Notes |
|---|---|---|
| Claude | `claude-sonnet-5` | Anthropic Messages API shape |
| ChatGPT | `gpt-5.6-terra` | Azure-OpenAI-style; model name goes in the URL path as a "deployment" |
| Gemini (text) | `gemini-3.6-flash` | |
| Gemini (image gen) | `gemini-3.1-flash-image` | needs `responseModalities: ['IMAGE','TEXT']` |

If a call 404s or rejects the model name, the id has probably rolled forward — check
h-chat-platform.autoever.com or an existing internal project for the current list rather than guessing.
