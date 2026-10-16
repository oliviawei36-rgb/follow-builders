import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { fetchHtml, extractArticle, isRecent } from './fetch-local-blogs.js';
import { shanghaiDate } from './feed-health.js';

const ROOT = process.env.FOLLOW_BUILDERS_USER_DIR || join(homedir(), '.follow-builders');
const POLICY = new URL('../config/discovery-policy.json', import.meta.url);
async function readJSON(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function atomicJSON(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(data, null, 2));
  await rename(temp, path);
}
export async function discoveryPlan({ now = new Date(), root = ROOT } = {}) {
  const policy = JSON.parse(await readFile(POLICY, 'utf8'));
  const state = await readJSON(join(root, 'discovery-state.json'), {});
  const date = shanghaiDate(now);
  const current = state.date === date ? state.result : null;
  return { date, lookbackDays: current ? (state.lookbackDays || policy.initialLookbackDays) : state.initialComplete ? policy.dailyLookbackDays : policy.initialLookbackDays,
    queries: policy.searchQueries, completed: !!current, result: current,
    instruction: 'Search every query using the web tool, verify useful leads against official publisher pages, then run discovery.js complete. Search snippets are leads, never source material.' };
}

function xmlText(block, tag) {
  return (block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').trim();
}
export function parseSearchFeed(xml, query) {
  if (!/<rss\b/i.test(xml)) throw new Error('Search service did not return an RSS feed');
  return [...xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)].map(([, block]) => ({
    queryId: query.id, title: xmlText(block, 'title'), url: xmlText(block, 'link'),
    snippet: xmlText(block, 'description'), verification: 'unverified_lead'
  })).filter(item => /^https?:\/\//.test(item.url));
}
export async function fetchDiscoveryLeads({ signal, lookbackDays } = {}) {
  const plan = await discoveryPlan();
  if (lookbackDays) plan.lookbackDays = lookbackDays;
  const searches = await Promise.all(plan.queries.map(async query => {
    try {
      const cutoff = new Date(Date.now() - plan.lookbackDays * 86400000).toISOString().slice(0, 10);
      const url = `https://www.bing.com/search?format=rss&q=${encodeURIComponent(`${query.query} after:${cutoff}`)}`;
      const xml = await fetchHtml(url, { signal, timeoutMs: 12000 });
      return { ...query, status: 'ok', candidates: parseSearchFeed(xml, query) };
    } catch (error) { return { ...query, status: 'error', reason: error.message, candidates: [] }; }
  }));
  return { generatedAt: new Date().toISOString(), lookbackDays: plan.lookbackDays, searches, leadsOnly: true };
}

export function mergeDiscovery(payload, result) {
  const planned = payload.discovery?.queries || [];
  if (planned.some(query => !result.queries?.some(item => item.id === query.id && ['ok', 'error'].includes(item.status)))) {
    throw new Error('Every planned search needs an explicit success or failure outcome');
  }
  const checked = new Date().toISOString();
  const records = planned.map(query => {
    const outcome = result.queries.find(item => item.id === query.id);
    if (outcome.status === 'error' && !outcome.reason) throw new Error('Failed searches need a reason');
    return { name: query.name, module: query.module, status: outcome.status === 'ok' ? 'ok' : 'error', reason: outcome.reason, checkedAt: checked };
  });
  const added = result.articles || [];
  for (const article of added) {
    if (article.verification !== 'official' || !/^https:\/\//.test(article.url || '') || !article.title || !article.content || !article.evidence || !article.eventId) {
      throw new Error('Discovery articles require an official HTTPS URL, title, verified content, evidence and eventId');
    }
    if (!planned.some(query => query.id === article.queryId)) throw new Error('Unknown discovery query');
    if (!article.publishedAt || !isRecent(article.publishedAt, payload.discovery.lookbackDays)) throw new Error('Missing or out-of-window publication date');
    if (!['AI 公司博客及产品更新', '法律 AI 产品', '律所与法务AI实践', '中国大模型厂商资讯'].includes(article.module)) throw new Error('Invalid discovery module');
  }
  const groups = result.eventGroups || [];
  const eventFor = new Map(groups.flatMap(group => (group.urls || []).map(url => [url, group.eventId])));
  const previous = new Set(payload.deliveredEventIds || []);
  const seenEvents = new Set();
  const seenUrls = new Set(payload.deliveredBlogUrls || []);
  payload.blogs = [...added, ...(payload.blogs || [])].filter(article => {
    article.eventId ||= eventFor.get(article.url);
    if (seenUrls.has(article.url) || (article.eventId && (previous.has(article.eventId) || seenEvents.has(article.eventId)))) return false;
    seenUrls.add(article.url);
    if (article.eventId) seenEvents.add(article.eventId);
    return true;
  });
  const names = new Set(records.map(item => item.name));
  payload.healthReport.sources = [...(payload.healthReport.sources || []).filter(item => !names.has(item.name)), ...records];
  payload.healthReport.failures = payload.healthReport.sources.filter(item => ['error', 'partial'].includes(item.status));
  if (added.length && ['error','stale'].includes(payload.sourceStatus.blogs?.status)) payload.sourceStatus.blogs = { ...payload.sourceStatus.blogs, status:'partial', generatedAt:checked };
  const failures = records.filter(item => item.status === 'error');
  if (failures.length) payload.sourceStatus.blogs = { ...payload.sourceStatus.blogs, status: 'partial', reason: failures.map(item => `${item.name}: ${item.reason}`).join('; ') };
  payload.discovery = { ...payload.discovery, completed: true, checkedAt: checked, result };
  payload.stats.blogPosts = payload.blogs.length;
  return payload;
}

export async function completeDiscovery(inputPath, resultsPath, { root = ROOT } = {}) {
  const payload = await readJSON(inputPath);
  const result = await readJSON(resultsPath);
  // Re-fetch official pages. Never promote search snippets into digest facts.
  const verified = [];
  for (const article of result.articles || []) {
    try {
    const html = await fetchHtml(article.url, { timeoutMs: 15000 });
    const fetched = extractArticle(html, article.url, article.name || '主题补漏');
    if (fetched.content.length < 100 || fetched.title === 'Untitled') throw new Error(`Official page could not be parsed: ${article.url}`);
    article.title = fetched.title;
    article.content = fetched.content;
    article.publishedAt = fetched.publishedAt || article.publishedAt;
    article.name ||= '主题补漏';
    article.verifiedAt = new Date().toISOString();
    verified.push(article);
    } catch (error) {
      const query = result.queries.find(item => item.id === article.queryId);
      if (query) { query.status = 'error'; query.reason = `Official page verification failed: ${article.url}: ${error.message}`; }
    }
  }
  result.articles = verified;
  mergeDiscovery(payload, result);
  await atomicJSON(inputPath, payload);
  const statePath = join(root, 'discovery-state.json');
  const old = await readJSON(statePath, {});
  const complete = result.queries.every(item => item.status === 'ok');
  await atomicJSON(statePath, { ...old, initialComplete: old.initialComplete || complete, lookbackDays: payload.discovery.lookbackDays, date: complete ? payload.discovery.date : null, result: complete ? result : null, lastAttempt: new Date().toISOString() });
  return { status: 'completed', articles: (result.articles || []).length, failures: payload.healthReport.failures.length, inputPath };
}
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  const value = flag => args[args.indexOf(flag) + 1];
  const result = args[0] === 'complete' ? await completeDiscovery(value('--input'), value('--results')) : await discoveryPlan();
  console.log(JSON.stringify(result, null, 2));
}
