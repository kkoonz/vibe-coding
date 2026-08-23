---
name: hmg-confluence
description: Use when a project needs to search, read, or publish pages to HMG(현대차그룹)'s internal Confluence instance (confluence.hmg-corp.io) via its REST API. Trigger on mentions of "confluence", "컨플루언스", CONFLUENCE_TOKEN/CONFLUENCE_URL, confluence.hmg-corp.io, personalaccesstokens, or requests to wire up Confluence space/page search or publishing in an internal HMG project. This is Confluence Server/Data Center (Personal Access Token + Bearer auth, `/rest/api/...` paths) — NOT Confluence Cloud (email+API-token, `/wiki/rest/api` paths); do not reuse Cloud-style auth code here.
---

# HMG Confluence API

Internal HMG projects talk to Confluence **Server/Data Center** (self-hosted), not Confluence Cloud. That
means Personal Access Token + `Authorization: Bearer <token>` auth and `/rest/api/...` paths — different
from the Cloud REST API's email+API-token Basic auth and `/wiki/rest/api` paths. Don't mix the two up.

- Base URL: `https://confluence.hmg-corp.io` (configurable — some deployments point elsewhere)
- Token issuance: https://confluence.hmg-corp.io/plugins/personalaccesstokens/usertokens.action
- Recommended env vars: `CONFLUENCE_URL`, `CONFLUENCE_TOKEN`

## Quick start

1. Get a Personal Access Token from the issuance URL above, put it in `.env`:
   ```
   CONFLUENCE_URL=https://confluence.hmg-corp.io
   CONFLUENCE_TOKEN=...
   ```
2. Copy `client.ts` from this skill into the target project (e.g. `lib/confluence.ts`) — dependency-free,
   just uses global `fetch`.
3. Use `getSpaces()`, `searchPages(query, spaceKeys)`, `getPageContent(pageId)`, `getDescendants(pageId)`,
   or `publishPage({...})` as needed.
4. Sanity-check the token before wiring up app code (see `reference.md` for a curl smoke test) — a bad or
   expired PAT typically comes back as an HTML login page, not a clean 401, which is easy to misdiagnose.

Read `reference.md` for the full endpoint list, CQL search-query construction (and required escaping/space-key
sanitization), pagination, and the page-content-representation fallback trick — don't guess at the REST API
shape, Confluence's content search response nesting is not obvious.

## Gotchas worth knowing up front

- A non-JSON response (`content-type` not `application/json`) almost always means the token expired or the
  URL is wrong and the server served an HTML login/error page — check `content-type` before parsing, don't
  let `res.json()` throw an opaque syntax error.
- Search is CQL-based (`/content/search?cql=...`), not a simple `?query=` param.
- Publishing a page always needs `space.key` + `body.storage.value` (Confluence storage-format XHTML, not
  arbitrary HTML) — see `reference.md` for what storage format tolerates.
