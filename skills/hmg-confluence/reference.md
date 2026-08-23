# HMG Confluence API contract (Server/Data Center)

Base URL: `{base}` = `https://confluence.hmg-corp.io` (or whatever `CONFLUENCE_URL` points to, trailing
slash stripped)

All requests:
```
Authorization: Bearer <CONFLUENCE_TOKEN>
Accept: application/json
```

Smoke test before writing app code:
```bash
curl -s -H "Authorization: Bearer $CONFLUENCE_TOKEN" -H "Accept: application/json" \
  "$CONFLUENCE_URL/rest/api/space?limit=1"
```
If this doesn't come back as JSON, stop and fix the token/URL before debugging app code — see "Gotchas" below.

---

## List / search spaces

`GET {base}/rest/api/space?limit=250&start={offset}&type=global&status=current`

Paginated: response has `results: [{ key, name, ... }]` and `_links.next` (present when more pages exist).
Loop bumping `start` by `limit` while `_links.next` exists and the last batch was full-size. There is no
server-side name filter on this endpoint — fetch all spaces (they're few thousand at most) and filter
client-side by name/key substring if you need a search box.

```json
{ "results": [{ "key": "ENG", "name": "Engineering" }], "_links": { "next": "/rest/api/space?..." } }
```

---

## Search pages — CQL

`GET {base}/rest/api/content/search?cql={encoded CQL}&limit=20&expand=space,body.view`

CQL (Confluence Query Language) query string, built like:
```
text~"<escaped query>" AND type=page[ AND space IN ("KEY1","KEY2")] ORDER BY lastmodified DESC
```
- Escape `"` in the free-text query as `\"` before interpolating.
- When filtering by space keys, **sanitize each key** to `[A-Z0-9_-]` only before interpolating into CQL —
  space keys come from user input/selection in most UIs and CQL injection via a crafted key is possible
  otherwise.
- `expand=space,body.view` pulls back rendered HTML body (`body.view.value`) and space info in the same
  call — strip HTML client-side (see `client.ts`'s `stripHtml`) to get plain-text excerpts for an LLM prompt.

Response shape:
```json
{
  "results": [
    {
      "id": "123456",
      "title": "Page title",
      "space": { "key": "ENG", "name": "Engineering" },
      "body": { "view": { "value": "<p>rendered html...</p>" } }
    }
  ]
}
```

---

## Get descendants of a page

`GET {base}/rest/api/content/{pageId}/descendant/page?limit=50&expand=space`

Returns child/descendant pages under a given page — useful for "include this whole doc tree as context"
features. Same `results[]` shape as search but without a body (fetch content per-page separately if needed).
Treat failures here as non-fatal (return `[]`) — this is typically an enrichment/nice-to-have, not a
blocking operation.

---

## Get a single page's content

There is no single reliable "get by id with body" call across all Confluence versions/plugins — the body
representation that actually renders (and is non-empty) varies. The robust approach used in this project:
run a CQL search scoped to that exact id, and **fall back across representations** in order:

```
for repr of ['view', 'storage', 'export_view']:
  GET {base}/rest/api/content/search?cql=id="{pageId}" AND type=page&limit=1&expand=space,body.{repr}
  if results[0].body[repr].value is non-empty after stripping HTML → use it, stop
```
Only throw if all three representations came back empty/failed — that means the page genuinely has no
readable body (or truly doesn't exist/isn't visible to this token).

---

## Publish (create) a page

`POST {base}/rest/api/content`
```
Content-Type: application/json
```
Body:
```json
{
  "type": "page",
  "title": "Page title",
  "space": { "key": "ENG" },
  "body": { "storage": { "value": "<p>Storage-format XHTML</p>", "representation": "storage" } },
  "ancestors": [{ "id": "123456" }]
}
```
- `ancestors` is optional — omit it to create a top-level page in the space.
- `body.storage.value` must be **Confluence storage format** (a constrained XHTML dialect), not arbitrary
  HTML — plain tags like `<p>`, `<strong>`, `<em>`, `<ul>/<li>`, `<h1>-<h6>`, `<table>` work; Confluence
  macros need `<ac:structured-macro>` syntax which is out of scope here. If generating body HTML from an
  LLM, keep the prompt constrained to these plain tags.
- Response: `{ id, ... }` — build a viewable URL as `{base}/pages/viewpage.action?pageId={id}`.
- This is *create* only. Updating an existing page requires `PUT {base}/rest/api/content/{id}` with the
  current `version.number + 1` in the body (not implemented in this project's reference client — add it if
  needed, following the same auth/response-check pattern).

---

## Gotchas

- **Non-JSON response = bad token or URL, not a parse bug.** Confluence Server serves an HTML login page
  (still HTTP 200 in some configs) when the PAT is invalid/expired. Always check
  `res.headers.get('content-type')?.includes('application/json')` before calling `res.json()`, and surface
  a clear "token expired or URL wrong" error instead of a JSON parse exception.
- Non-2xx responses: read the body as text (bounded, e.g. first 300 chars) and include the HTTP status in
  the thrown error.
- Personal Access Tokens can be scoped/expiring — if search suddenly 401s in production, the first thing to
  check is token expiry, not code.
