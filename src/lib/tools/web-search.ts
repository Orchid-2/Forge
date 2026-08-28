/**
 * Web search across four providers.
 *
 * DuckDuckGo is the default because it needs no API key — important for an app
 * that should work the moment it is installed. SearXNG covers self-hosters who
 * want search without leaving their network; Tavily and Brave are there for
 * anyone who wants better results and has a key.
 */
import 'server-only';

import { getSettings } from '@/lib/settings';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Present when the provider returns a publication date. */
  publishedAt?: string;
}

export async function webSearch(
  query: string,
  options: { limit?: number; signal?: AbortSignal } = {},
): Promise<SearchResult[]> {
  const settings = getSettings();
  const limit = options.limit ?? settings.searchMaxResults;

  switch (settings.searchProvider) {
    case 'tavily':
      return tavilySearch(query, limit, settings.tavilyApiKey, options.signal);
    case 'brave':
      return braveSearch(query, limit, settings.braveApiKey, options.signal);
    case 'searxng':
      return searxngSearch(query, limit, settings.searxngBaseUrl, options.signal);
    default:
      return duckDuckGoSearch(query, limit, options.signal);
  }
}

/**
 * DuckDuckGo via its HTML endpoint.
 *
 * There is no official free JSON API; the Instant Answer API only returns
 * disambiguation pages, not results. Scraping the lite HTML endpoint is the
 * standard approach and needs no key, at the cost of being markup-dependent —
 * hence the defensive parsing and the clear error when the shape changes.
 */
async function duckDuckGoSearch(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const response = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // Without a browser-like UA the endpoint returns an interstitial.
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
    },
    body: new URLSearchParams({ q: query, kl: 'wt-wt' }),
    signal: signal ?? AbortSignal.timeout(15_000),
  });

  if (!response.ok) throw new Error(`DuckDuckGo returned HTTP ${response.status}`);

  const html = await response.text();
  const results: SearchResult[] = [];

  // Each result is an anchor with class `result__a`, followed by a snippet.
  const linkPattern =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetPattern = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const links = [...html.matchAll(linkPattern)];
  const snippets = [...html.matchAll(snippetPattern)];

  for (let i = 0; i < Math.min(links.length, limit); i++) {
    const href = links[i][1];
    const url = unwrapDuckDuckGoUrl(href);
    if (!url) continue;

    results.push({
      title: stripHtml(links[i][2]),
      url,
      snippet: snippets[i] ? stripHtml(snippets[i][1]) : '',
    });
  }

  return results;
}

/** DuckDuckGo wraps result links in a redirect carrying the target in `uddg`. */
function unwrapDuckDuckGoUrl(href: string): string | null {
  try {
    const decoded = href.startsWith('//') ? `https:${href}` : href;
    const url = new URL(decoded, 'https://duckduckgo.com');
    const target = url.searchParams.get('uddg');
    const resolved = target ? decodeURIComponent(target) : decoded;
    return resolved.startsWith('http') ? resolved : null;
  } catch {
    return null;
  }
}

async function searxngSearch(
  query: string,
  limit: number,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (!baseUrl) throw new Error('SearXNG selected but no base URL is configured in Settings.');

  const url = new URL('/search', baseUrl.replace(/\/+$/, ''));
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  const response = await fetch(url, { signal: signal ?? AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`SearXNG returned HTTP ${response.status}`);

  const data = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string }>;
  };

  return (data.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
    publishedAt: r.publishedDate,
  }));
}

async function tavilySearch(
  query: string,
  limit: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (!apiKey) throw new Error('Tavily selected but no API key is configured in Settings.');

  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: apiKey,
      query,
      max_results: limit,
      search_depth: 'basic',
    }),
    signal: signal ?? AbortSignal.timeout(20_000),
  });

  if (!response.ok) throw new Error(`Tavily returned HTTP ${response.status}`);

  const data = (await response.json()) as {
    results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
  };

  return (data.results ?? []).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: r.content ?? '',
    publishedAt: r.published_date,
  }));
}

async function braveSearch(
  query: string,
  limit: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  if (!apiKey) throw new Error('Brave selected but no API key is configured in Settings.');

  const url = new URL('https://api.search.brave.com/res/v1/web/search');
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(limit));

  const response = await fetch(url, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
    signal: signal ?? AbortSignal.timeout(20_000),
  });

  if (!response.ok) throw new Error(`Brave returned HTTP ${response.status}`);

  const data = (await response.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string; age?: string }> };
  };

  return (data.web?.results ?? []).slice(0, limit).map((r) => ({
    title: r.title ?? '',
    url: r.url ?? '',
    snippet: stripHtml(r.description ?? ''),
    publishedAt: r.age,
  }));
}

/**
 * Fetches a page and reduces it to readable text.
 *
 * Deliberately not a full readability implementation: strip the non-content
 * elements, unwrap the tags, collapse whitespace. That is enough for a model to
 * read and costs no dependency.
 */
export async function fetchPageText(
  url: string,
  options: { maxChars?: number; signal?: AbortSignal } = {},
): Promise<{ title: string; text: string; url: string }> {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('Only http and https URLs can be fetched.');
  }

  const response = await fetch(target, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; Forge/0.1; +local personal assistant)',
      Accept: 'text/html,application/xhtml+xml,text/plain',
    },
    signal: options.signal ?? AbortSignal.timeout(20_000),
    redirect: 'follow',
  });

  if (!response.ok) throw new Error(`Fetch failed with HTTP ${response.status}`);

  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();

  if (!contentType.includes('html')) {
    return { title: target.hostname, text: body.slice(0, options.maxChars ?? 12_000), url: target.href };
  }

  const titleMatch = body.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? stripHtml(titleMatch[1]) : target.hostname;

  const text = body
    // Remove elements whose text content is never page content.
    .replace(/<(script|style|noscript|svg|nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Keep block boundaries as newlines so paragraphs survive.
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');

  return {
    title,
    text: decodeEntities(text).replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, options.maxChars ?? 12_000),
    url: target.href,
  };
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–',
    hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', copy: '©', reg: '®',
  };
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, entity) => named[entity.toLowerCase()] ?? match);
}
