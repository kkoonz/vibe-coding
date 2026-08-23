/**
 * HMG Confluence (Server/Data Center) API client — thin fetch wrapper.
 * Dependency-free (global fetch only). Node 18+ / Next.js / Vite / etc.
 *
 * Setup: set CONFLUENCE_URL + CONFLUENCE_TOKEN in the environment, or pass `apiKey`/`baseUrl` explicitly.
 * Token issuance: https://confluence.hmg-corp.io/plugins/personalaccesstokens/usertokens.action
 *
 * NOTE: this is Confluence Server/Data Center (Bearer PAT, /rest/api/...), not Confluence Cloud.
 * See reference.md in this skill for the full endpoint contract.
 */

export interface ConfluenceConfig {
  baseUrl?: string
  token?: string
}

function resolveConfig(config?: ConfluenceConfig) {
  const baseUrl = (config?.baseUrl ?? process.env.CONFLUENCE_URL ?? 'https://confluence.hmg-corp.io').replace(/\/$/, '')
  const token = config?.token ?? process.env.CONFLUENCE_TOKEN ?? ''
  if (!token) throw new Error('CONFLUENCE_TOKEN is not set (env var or config.token)')
  return { baseUrl, token }
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

async function confFetch(path: string, options: RequestInit, config?: ConfluenceConfig): Promise<Response> {
  const { baseUrl, token } = resolveConfig(config)
  const res = await fetch(`${baseUrl}/rest/api${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(options.headers ?? {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`Confluence API ${res.status}: ${text.slice(0, 300)}`)
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('application/json')) {
    throw new Error('Confluence response was not JSON — token likely expired or URL is wrong')
  }
  return res
}

export interface Space { key: string; name: string }
export interface SearchResult {
  id: string
  title: string
  space: string
  spaceKey: string
  excerpt: string
}

export async function getSpaces(config?: ConfluenceConfig, query?: string): Promise<Space[]> {
  const all: Space[] = []
  let start = 0
  const limit = 250
  while (true) {
    const res = await confFetch(`/space?limit=${limit}&start=${start}&type=global&status=current`, { method: 'GET' }, config)
    const data = await res.json()
    const batch = (data.results ?? [])
      .map((s: { key?: string; name?: string }) => ({ key: s.key ?? '', name: s.name ?? '' }))
      .filter((s: Space) => s.key)
    all.push(...batch)
    if (!data._links?.next || batch.length < limit) break
    start += limit
  }
  if (!query) return all
  const q = query.toLowerCase()
  return all.filter((s) => s.name.toLowerCase().includes(q) || s.key.toLowerCase().includes(q))
}

export async function searchPages(query: string, spaceKeys: string[] = [], config?: ConfluenceConfig): Promise<SearchResult[]> {
  const escaped = query.replace(/"/g, '\\"')
  const safeKey = (k: string) => k.replace(/[^A-Z0-9_-]/gi, '')
  const cleanKeys = spaceKeys.map(safeKey).filter(Boolean)
  const spaceFilter = cleanKeys.length > 0 ? ` AND space IN (${cleanKeys.map((k) => `"${k}"`).join(',')})` : ''
  const cql = `text~"${escaped}" AND type=page${spaceFilter} ORDER BY lastmodified DESC`
  const res = await confFetch(`/content/search?cql=${encodeURIComponent(cql)}&limit=20&expand=space,body.view`, { method: 'GET' }, config)
  const data = await res.json()
  return (data.results ?? [])
    .map((r: { id?: string; title?: string; space?: { key?: string; name?: string }; body?: { view?: { value?: string } } }) => ({
      id: String(r.id ?? ''),
      title: r.title ?? '(no title)',
      space: r.space?.name ?? '',
      spaceKey: r.space?.key ?? '',
      excerpt: stripHtml(r.body?.view?.value ?? '').slice(0, 200),
    }))
    .filter((r: SearchResult) => r.id)
}

export async function getDescendants(pageId: string, config?: ConfluenceConfig, limit = 50): Promise<SearchResult[]> {
  try {
    const res = await confFetch(`/content/${pageId}/descendant/page?limit=${limit}&expand=space`, { method: 'GET' }, config)
    const data = await res.json()
    return (data.results ?? [])
      .map((r: { id?: string; title?: string; space?: { key?: string; name?: string } }) => ({
        id: String(r.id ?? ''),
        title: r.title ?? '(no title)',
        space: r.space?.name ?? '',
        spaceKey: r.space?.key ?? '',
        excerpt: '',
      }))
      .filter((r: SearchResult) => r.id)
  } catch {
    return []
  }
}

export async function getPageContent(pageId: string, config?: ConfluenceConfig): Promise<{ title: string; content: string }> {
  const cql = encodeURIComponent(`id = "${pageId}" AND type=page`)
  for (const repr of ['view', 'storage', 'export_view']) {
    try {
      const res = await confFetch(`/content/search?cql=${cql}&limit=1&expand=space,body.${repr}`, { method: 'GET' }, config)
      const data = await res.json()
      const page = data.results?.[0]
      if (!page) break
      const text = stripHtml(page.body?.[repr]?.value ?? '')
      if (text) return { title: page.title ?? '', content: text }
    } catch {
      // try next representation
    }
  }
  throw new Error(`Could not load content for page ${pageId} — Confluence server error or empty body across all representations`)
}

export interface PublishOptions {
  spaceKey: string
  title: string
  /** Confluence storage-format XHTML (not arbitrary HTML) — see reference.md */
  bodyHtml: string
  parentId?: string
}

export async function publishPage(opts: PublishOptions, config?: ConfluenceConfig): Promise<{ id: string; url: string }> {
  const { baseUrl } = resolveConfig(config)
  const payload: Record<string, unknown> = {
    type: 'page',
    title: opts.title,
    space: { key: opts.spaceKey },
    body: { storage: { value: opts.bodyHtml, representation: 'storage' } },
  }
  if (opts.parentId) payload.ancestors = [{ id: opts.parentId }]
  const res = await confFetch('/content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, config)
  const data = await res.json()
  return { id: String(data.id), url: `${baseUrl}/pages/viewpage.action?pageId=${data.id}` }
}
