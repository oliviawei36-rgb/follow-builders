import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";

const SCRIPT_DIR = decodeURIComponent(new URL(".", import.meta.url).pathname);
const SOURCES_PATH = join(SCRIPT_DIR, "..", "config", "local-sources.json");
const STATE_PATH = join(homedir(), ".follow-builders", "local-source-state.json");
const LOOKBACK_HOURS = 72;
const MAX_CANDIDATES_PER_SOURCE = 12;
const MAX_ARTICLES_PER_SOURCE = 3;
const REQUEST_TIMEOUT_MS = Number(
  process.env.FOLLOW_BUILDERS_REQUEST_TIMEOUT_MS || 6000
);
const SOURCE_CONCURRENCY = Number(
  process.env.FOLLOW_BUILDERS_SOURCE_CONCURRENCY || 4
);
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const execFileAsync = promisify(execFile);

function decodeHtml(value = "") {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripHtml(value = "") {
  return decodeHtml(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function extractXmlValue(block, tag) {
  const match = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return match ? stripHtml(match[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")) : "";
}

function parseAtomFeed(xml, source) {
  const entries = [];
  const entryRegex = /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi;
  let match;

  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[1];
    const href = block.match(/<link[^>]+href=["']([^"']+)["'][^>]*>/i)?.[1];
    const url = normalizeUrl(href || "", source.indexUrl);
    if (
      !url ||
      !source.articlePrefixes.some((prefix) => url.startsWith(prefix)) ||
      source.excludeUrls?.includes(url)
    ) continue;
    entries.push({
      source: "blog",
      name: source.name,
      title: extractXmlValue(block, "title") || "Untitled",
      url,
      publishedAt: extractXmlValue(block, "updated") || extractXmlValue(block, "published") || null,
      author: extractXmlValue(block, "name"),
      description: "",
      content: extractXmlValue(block, "content") || extractXmlValue(block, "summary"),
    });
  }

  return entries;
}

function parseRssFeed(xml, source) {
  const entries = [];
  const itemRegex = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;

  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const url = normalizeUrl(extractXmlValue(block, "link"), source.indexUrl);
    if (
      !url ||
      !source.articlePrefixes.some((prefix) => url.startsWith(prefix)) ||
      source.excludeUrls?.includes(url)
    ) continue;
    entries.push({
      source: "blog",
      name: source.name,
      title: extractXmlValue(block, "title") || "Untitled",
      url,
      publishedAt:
        extractXmlValue(block, "pubDate") ||
        extractXmlValue(block, "dc:date") ||
        null,
      author:
        extractXmlValue(block, "dc:creator") ||
        extractXmlValue(block, "author"),
      description: extractXmlValue(block, "description"),
      content:
        extractXmlValue(block, "content:encoded") ||
        extractXmlValue(block, "description"),
    });
  }

  return entries;
}

function parseSyndicationFeed(xml, source) {
  return /<feed\b/i.test(xml)
    ? parseAtomFeed(xml, source)
    : parseRssFeed(xml, source);
}

function normalizeUrl(href, indexUrl) {
  try {
    const url = new URL(decodeHtml(href), indexUrl);
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function discoverCandidates(html, source) {
  const candidates = [];
  const seen = new Set();
  const hrefRegex = /href=["']([^"']+)["']/gi;
  let match;

  if (source.includeIndex) {
    candidates.push(source.indexUrl);
    seen.add(source.indexUrl);
  }

  while ((match = hrefRegex.exec(html)) !== null) {
    const url = normalizeUrl(match[1], source.indexUrl);
    if (!url || seen.has(url) || url === source.indexUrl) continue;
    if (!source.articlePrefixes.some((prefix) => url.startsWith(prefix))) continue;
    if (source.excludeUrls?.includes(url)) continue;
    if (/\/(tag|category|page|author)\//i.test(url)) continue;
    if (/\/feed\/?(?:\?|$)/i.test(url)) continue;
    if (/\/wp-content\/|\.(?:ico|png|jpe?g|gif|svg|css|js|xml|rss|md)(?:\?|$)/i.test(url)) continue;
    seen.add(url);
    candidates.push(url);
    if (candidates.length >= MAX_CANDIDATES_PER_SOURCE) break;
  }

  return candidates;
}

function discoverSitemapCandidates(xml, source) {
  const discovered = [];
  const urlBlockRegex = /<url>([\s\S]*?)<\/url>/gi;
  let match;

  while ((match = urlBlockRegex.exec(xml)) !== null) {
    const location = match[1].match(/<loc>([\s\S]*?)<\/loc>/i)?.[1];
    const lastModified = match[1].match(/<lastmod>([\s\S]*?)<\/lastmod>/i)?.[1] || null;
    const url = normalizeUrl(stripHtml(location || ""), source.indexUrl);
    if (!url) continue;
    if (!source.articlePrefixes.some((prefix) => url.startsWith(prefix))) continue;
    if (source.excludeUrls?.includes(url)) continue;
    if (/\/(tag|category|page|author)\//i.test(url)) continue;
    discovered.push({ url, lastModified });
  }

  return discovered
    .sort((a, b) => {
      const aTime = a.lastModified ? new Date(a.lastModified).getTime() : 0;
      const bTime = b.lastModified ? new Date(b.lastModified).getTime() : 0;
      return bTime - aTime;
    })
    .slice(0, MAX_CANDIDATES_PER_SOURCE)
    .map((item) => item.url);
}

function parseJsonLd(html) {
  const entries = [];
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      entries.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      // Ignore malformed structured data and use HTML metadata instead.
    }
  }
  return entries.flatMap((entry) => entry?.["@graph"] || entry || []);
}

function metaContent(html, key, attribute = "property") {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]*${attribute}=["']${escaped}["'][^>]*content=["']([^"']*)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]*content=["']([^"']*)["'][^>]*${attribute}=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeHtml(match[1]).trim();
  }
  return "";
}

function extractArticle(html, url, sourceName) {
  const structured = parseJsonLd(html).find((entry) => {
    const type = entry?.["@type"];
    return type === "Article" || type === "BlogPosting" || type === "NewsArticle";
  });
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const title =
    structured?.headline ||
    metaContent(html, "og:title") ||
    (h1 ? stripHtml(h1[1]) : "") ||
    "Untitled";
  const publishedAt =
    structured?.datePublished ||
    metaContent(html, "article:published_time") ||
    metaContent(html, "date", "name") ||
    null;
  const authorValue = structured?.author;
  const author =
    (Array.isArray(authorValue) ? authorValue[0]?.name : authorValue?.name) ||
    metaContent(html, "author", "name") ||
    "";
  const articleBody =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i)?.[1] ||
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i)?.[1] ||
    html;
  const content = stripHtml(articleBody).slice(0, 50000);

  return {
    source: "blog",
    name: sourceName,
    title,
    url,
    publishedAt,
    author,
    description: metaContent(html, "description", "name"),
    content,
  };
}

function isRecent(publishedAt) {
  if (!publishedAt) return true;
  const timestamp = new Date(publishedAt).getTime();
  if (!Number.isFinite(timestamp)) return true;
  return timestamp >= Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000;
}

function matchesKeywords(article, source) {
  if (source.includeTitleKeywords?.length) {
    const title = article.title.toLowerCase();
    if (!source.includeTitleKeywords.some((keyword) => title.includes(keyword.toLowerCase()))) {
      return false;
    }
  }
  if (!source.includeKeywords?.length) return true;
  const searchable = `${article.title} ${article.description} ${article.content}`.toLowerCase();
  return source.includeKeywords.some((keyword) => searchable.includes(keyword.toLowerCase()));
}

function contentHash(article) {
  return createHash("sha256")
    .update(`${article.title}\n${article.content}`)
    .digest("hex");
}

async function readState() {
  try {
    return JSON.parse(await readFile(STATE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

async function writeState(state) {
  await mkdir(join(homedir(), ".follow-builders"), { recursive: true });
  await writeFile(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

function requestSignal(signal, timeoutMs) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

export async function fetchHtml(url, { signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let response;
  try {
    response = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: requestSignal(signal, timeoutMs),
    });
    if (response.ok) return response.text();
  } catch {
    if (signal?.aborted) throw new Error("overall deadline exceeded");
    // Fall back to curl for sites that reject or stall Node's fetch.
  }

  // Some legal-tech sites challenge Node's fetch but allow a normal browser-like curl request.
  try {
    const { stdout } = await execFileAsync(
      "curl",
      ["-L", "-sS", "--fail", "--max-time", String(Math.ceil(timeoutMs / 1000)), url],
      {
        maxBuffer: 20 * 1024 * 1024,
        signal,
        timeout: timeoutMs,
      },
    );
    return stdout;
  } catch {
    if (signal?.aborted) throw new Error("overall deadline exceeded");
    throw new Error(response ? `HTTP ${response.status}` : "request timed out");
  }
}

export async function fetchLocalBlogs({ signal } = {}) {
  const errors = [];
  const blogs = [];
  const sourceHealth = [];
  let config;
  const state = await readState();
  let stateChanged = false;

  try {
    config = JSON.parse(await readFile(SOURCES_PATH, "utf-8"));
  } catch (error) {
    return { blogs, errors: [`Local blogs: could not read sources: ${error.message}`] };
  }

  const sources = config.blogs || [];
  let nextSourceIndex = 0;

  async function processSources() {
    while (nextSourceIndex < sources.length && !signal?.aborted) {
      const source = sources[nextSourceIndex];
      nextSourceIndex += 1;
      const startCount = blogs.length;
      const startErrors = errors.length;
      const health = { name: source.name, module: source.module, checkedAt: new Date().toISOString(), status: 'no_updates', count: 0 };
    try {
      if (source.feedUrl) {
        const xml = await fetchHtml(source.feedUrl, { signal });
        if (!/<(?:rss|feed)\b/i.test(xml)) throw new Error('Response is not a valid RSS or Atom feed');
        const entries = parseSyndicationFeed(xml, source)
          .filter((article) => article.content && isRecent(article.publishedAt))
          .filter((article) => matchesKeywords(article, source))
          .slice(0, MAX_ARTICLES_PER_SOURCE);
        blogs.push(...entries.map(article => ({ ...article, module: source.module })));
        continue;
      }

      const discoveryUrl = source.sitemapUrl || source.indexUrl;
      const indexHtml = await fetchHtml(discoveryUrl, { signal });
      const candidates = source.sitemapUrl
        ? discoverSitemapCandidates(indexHtml, source)
        : discoverCandidates(indexHtml, source);
      if (!candidates.length) throw new Error('Page retrieved but article index could not be parsed');
      let added = 0;

      for (const url of candidates) {
        if (signal?.aborted) break;
        try {
          const article = extractArticle(await fetchHtml(url, { signal }), url, source.name);
          if (!article.content || !isRecent(article.publishedAt) || !matchesKeywords(article, source)) continue;
          if (source.watchPage) {
            const hash = contentHash(article);
            if (state[source.name] === hash) continue;
            state[source.name] = hash;
            stateChanged = true;
            article.publishedAt = new Date().toISOString();
          }
          blogs.push({ ...article, module: source.module });
          added += 1;
          if (added >= MAX_ARTICLES_PER_SOURCE) break;
        } catch (error) {
          errors.push(`Local blog ${source.name}: ${url}: ${error.message}`);
        }
      }
    } catch (error) {
      errors.push(`Local blog ${source.name}: index: ${error.message}`);
    } finally {
      const ownErrors = errors.slice(startErrors).filter(message => message.includes(source.name));
      health.count = blogs.filter(article => article.name === source.name).length;
      health.status = ownErrors.length ? (health.count ? 'partial' : 'error') : health.count ? 'ok' : 'no_updates';
      if (ownErrors.length) health.reason = ownErrors.join('; ');
      sourceHealth.push(health);
    }
    }
  }

  const workerCount = Math.max(1, Math.min(SOURCE_CONCURRENCY, sources.length));
  await Promise.all(Array.from({ length: workerCount }, () => processSources()));
  if (signal?.aborted) {
    errors.push("Local blogs: overall deadline exceeded; returned partial results");
  }

  if (stateChanged) {
    try {
      await writeState(state);
    } catch (error) {
      errors.push(`Local blogs: could not save change-detection state: ${error.message}`);
    }
  }

  for (const source of sources) {
    if (!sourceHealth.some(health => health.name === source.name)) sourceHealth.push({ name: source.name, module: source.module, status: 'error', count: 0, reason: 'Not checked: overall fetch deadline exceeded' });
  }
  return { blogs, errors, sourceHealth };
}

if (process.argv[1] === decodeURIComponent(new URL(import.meta.url).pathname)) {
  fetchLocalBlogs()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
