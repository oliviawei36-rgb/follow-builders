#!/usr/bin/env node
import { readFile, writeFile, mkdir, rename, unlink, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { main as prepareDigest, fetchJSON } from './prepare-digest.js';
import { inspectFeed, shanghaiDate, usable } from './feed-health.js';

const exec = promisify(execFile);
const ROOT = process.env.FOLLOW_BUILDERS_USER_DIR || join(homedir(), '.follow-builders');
const STATE = join(ROOT, 'delivery-state.json');
const RECEIPTS = join(ROOT, 'receipts');
const SCRIPT_DIR = dirname(new URL(import.meta.url).pathname);
const REPO = 'oliviawei36-rgb/follow-builders';
const FEED = `https://raw.githubusercontent.com/${REPO}/main/feed-x.json`;
const ALL = ['x', 'blogs', 'podcasts'];
const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const has = (name) => args.includes(name);
const selected = () => has('--sources') ? option('--sources').split(',') : ALL;

async function readJSON(path, fallback = {}) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
async function atomicJSON(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}
function completed(record) { return ['delivered', 'empty'].includes(record?.status); }

export async function reconcile() {
  await mkdir(RECEIPTS, { recursive: true });
  const state = await readJSON(STATE, { deliveredDates: {} });
  if (state.schemaVersion !== 2) {
    state.legacyLastSuccessfulDeliveryDate = state.lastSuccessfulDeliveryDate;
    delete state.lastSuccessfulDeliveryDate;
    delete state.lastSuccessfulDeliveryAt;
  }
  state.schemaVersion = 2;
  state.deliveredDates ||= {};
  for (const name of await readdir(RECEIPTS)) {
    if (!name.endsWith('.json')) continue;
    const path = join(RECEIPTS, name);
    const receipt = await readJSON(path);
    if (receipt.status === 'verified') continue;
    const { stdout } = await exec('python3', [join(SCRIPT_DIR, 'verify-delivery.py'), receipt.threadId, receipt.digestPath, receipt.stagedAt], { timeout: 30000 });
    const result = JSON.parse(stdout);
    if (!result.verified) continue;
    const day = state.deliveredDates[receipt.date] ||= {};
    day.sources ||= {};
    for (const source of receipt.sources) {
      const health = receipt.sourceStatus[source];
      day.sources[source] = {
        status: health.status === 'partial' ? 'partial' : health.status === 'empty' ? 'empty' : 'delivered',
        feedGeneratedAt: health.generatedAt, ...result.evidence,
        urls: [...new Set([...(day.sources[source]?.urls || []), ...(receipt.urls[source] || [])])],
        eventIds: [...new Set([...(day.sources[source]?.eventIds || []), ...(receipt.eventIds?.[source] || [])])]
      };
    }
    day.status = ALL.every(s => completed(day.sources[s])) ? 'success' : 'partial';
    day.deliveredAt = result.evidence.deliveredAt;
    if (day.status === 'success') {
      state.lastSuccessfulDeliveryDate = receipt.date;
      state.lastSuccessfulDeliveryAt = day.deliveredAt;
    }
    receipt.status = 'verified';
    receipt.evidence = result.evidence;
    // Persist delivery first. Repeating reconciliation after an interrupted write is idempotent.
    await atomicJSON(STATE, state);
    await atomicJSON(path, receipt);
  }
  return state;
}

async function refreshX() {
  const health = inspectFeed(await fetchJSON(FEED), 'x');
  if (['ok', 'empty'].includes(health.status)) return { status: 'current' };
  const refreshState = join(ROOT, 'refresh-state.json');
  const previous = await readJSON(refreshState);
  if (Date.now() - Date.parse(previous.at || 0) < 3600000) return { status: 'cooldown', health };
  try {
    const { stdout } = await exec('gh', ['run', 'list', '--repo', REPO, '--workflow', 'generate-feed.yml', '--limit', '5', '--json', 'databaseId,status,createdAt'], { timeout: 30000 });
    let running = JSON.parse(stdout).find(r => ['queued', 'in_progress', 'waiting', 'requested', 'pending'].includes(r.status));
    await atomicJSON(refreshState, { at: new Date().toISOString() });
    if (!running) {
      await exec('gh', ['workflow', 'run', 'generate-feed.yml', '--repo', REPO, '-f', 'mode=tweets-only'], { timeout: 30000 });
      await new Promise(resolve => setTimeout(resolve, 3000));
      const next = await exec('gh', ['run', 'list', '--repo', REPO, '--workflow', 'generate-feed.yml', '--limit', '1', '--json', 'databaseId,status'], { timeout: 30000 });
      running = JSON.parse(next.stdout)[0];
    }
    if (!running) return { status: 'requested' };
    for (let attempt = 0; attempt < 12; attempt++) {
      const result = await exec('gh', ['run', 'view', String(running.databaseId), '--repo', REPO, '--json', 'status,conclusion,url'], { timeout: 15000 });
      const run = JSON.parse(result.stdout);
      if (run.status === 'completed') return run;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    return { status: 'running', runId: running.databaseId };
  } catch (error) { return { status: 'error', reason: error.message.slice(0, 500) }; }
}

async function acquireLock() {
  await mkdir(ROOT, { recursive: true });
  const path = join(ROOT, 'daily-run.lock');
  const runId = randomUUID();
  try { await writeFile(path, JSON.stringify({ runId, at: new Date().toISOString() }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const lock = await readJSON(path);
    if (Date.now() - Date.parse(lock.at) < 120 * 60000) return null;
    await unlink(path);
    return acquireLock();
  }
  return runId;
}
async function release(runId) {
  const path = join(ROOT, 'daily-run.lock');
  const lock = await readJSON(path);
  if (lock.runId === runId) await unlink(path);
}

async function prepare() {
  const now = new Date(process.env.FOLLOW_BUILDERS_NOW || Date.now());
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  if (time < '08:00' && !has('--force')) return { status: 'before_delivery_time' };
  const runId = await acquireLock();
  if (!runId) return { status: 'busy' };
  try {
    const state = await reconcile();
    const date = shanghaiDate(now);
    const records = state.deliveredDates?.[date]?.sources || {};
    const deliveredUrls = Object.fromEntries(ALL.map(source => [source, [...new Set(Object.values(state.deliveredDates || {}).flatMap(day => day.sources?.[source]?.urls || []))]]));
    const wanted = selected().filter(s => ALL.includes(s) && !completed(records[s]));
    if (!wanted.length) return { status: 'already_delivered', date };
    // A staged receipt is only retried after checking the actual final response.
    for (const name of await readdir(RECEIPTS)) {
      const receipt = await readJSON(join(RECEIPTS, name));
      if (receipt.date !== date || receipt.status !== 'staged' || !receipt.sources.some(s => wanted.includes(s))) continue;
      if (Date.now() - Date.parse(receipt.stagedAt) < 15 * 60000) return { status: 'awaiting_delivery_receipt', date };
      return { status: 'retry_staged_output', date, digestPath: receipt.digestPath, instruction: 'Output the saved digest exactly as a normal final reply.' };
    }
    const refresh = wanted.includes('x') && !has('--no-refresh') ? await refreshX() : undefined;
    const payload = await prepareDigest({ excludeSources: ALL.filter(s => !wanted.includes(s)), emit: false });
    payload.deliveredBlogUrls = deliveredUrls.blogs;
    payload.deliveredEventIds = [...new Set(Object.values(state.deliveredDates || {}).flatMap(day => day.sources?.blogs?.eventIds || []))];
    // Preserve undelivered articles across retries; local scraping has its own fetch-time deduplication.
    const pendingPath = join(ROOT, 'pending', `${date}.json`);
    const previous = await readJSON(pendingPath);
    for (const key of wanted) {
      const candidates = [...(previous[key] || []), ...(payload[key] || [])];
      if (key === 'x') {
        const byHandle = new Map();
        for (const author of candidates) {
          const current = byHandle.get(author.handle) || { ...author, tweets: [] };
          const tweets = new Map(current.tweets.map(t => [t.url, t]));
          for (const tweet of author.tweets) if (!deliveredUrls.x.includes(tweet.url)) tweets.set(tweet.url, tweet);
          current.tweets = [...tweets.values()];
          byHandle.set(author.handle, current);
        }
        payload.x = [...byHandle.values()].filter(a => a.tweets.length);
      } else {
        payload[key] = [...new Map(candidates.filter(item => !deliveredUrls[key].includes(item.url) && !(item.eventId && payload.deliveredEventIds.includes(item.eventId))).map(item => [item.url, item])).values()];
      }
    }
    payload.stats.xBuilders = payload.x.length;
    payload.stats.totalTweets = payload.x.reduce((n, a) => n + a.tweets.length, 0);
    payload.stats.podcastEpisodes = payload.podcasts.length;
    payload.stats.blogPosts = payload.blogs.length;
    for (const key of wanted) {
      if (payload[key].length && payload.sourceStatus[key].status === 'empty') payload.sourceStatus[key].status = 'ok';
    }
    const eligible = wanted.filter(s => usable(payload.sourceStatus[s]) && (payload.sourceStatus[s].status !== 'partial' || payload[s].length));
    await atomicJSON(pendingPath, payload);
    const inputPath = join(ROOT, 'pending', `${date}-${runId}.json`);
    await atomicJSON(inputPath, payload);
    return { status: eligible.length ? 'ready' : 'sources_unavailable', date, runId, inputPath, sources: eligible, sourceStatus: payload.sourceStatus, stats: payload.stats, refresh };
  } finally { await release(runId); }
}

async function stage() {
  const runId = await acquireLock();
  if (!runId) return { status: 'busy' };
  try {
    const payload = await readJSON(option('--input'));
    const digest = (await readFile(option('--digest'), 'utf8')).trim();
    if (!digest) throw new Error('Cannot stage an empty digest');
    const sources = selected().filter(s => usable(payload.sourceStatus?.[s]));
    if (!sources.length || sources.length !== selected().length) throw new Error('Cannot mark failed or stale sources as delivered');
    if (!has('--thread-id')) throw new Error('Delivery thread is required');
    if (sources.includes('blogs') && payload.discovery && !payload.discovery.completed) throw new Error('Complete daily topic discovery before staging blogs');
    const date = shanghaiDate();
    const state = await reconcile();
    if (sources.some(source => completed(state.deliveredDates?.[date]?.sources?.[source]))) return { status: 'already_delivered', instruction: 'Prepare again to exclude completed sources; do not output this duplicate digest.' };
    for (const name of await readdir(RECEIPTS)) {
      const other = await readJSON(join(RECEIPTS, name));
      if (other.date === date && other.status === 'staged' && other.sources.some(source => sources.includes(source))) return { status: 'already_staged', instruction: 'Another delivery is awaiting verification. Do not publish a duplicate.' };
    }
    const id = randomUUID();
    const digestPath = join(ROOT, 'digests', `${date}-${id}.md`);
    await mkdir(dirname(digestPath), { recursive: true });
    await writeFile(digestPath, digest + '\n', { mode: 0o600 });
    const urls = Object.fromEntries(sources.map(s => [s, s === 'x' ? (payload.x || []).flatMap(a => a.tweets.map(t => t.url)) : (payload[s] || []).map(t => t.url)]));
    const eventIds = { blogs: [...new Set((payload.blogs || []).map(item => item.eventId).filter(Boolean))] };
    const receipt = { id, date, status: 'staged', stagedAt: new Date().toISOString(), threadId: option('--thread-id'), digestPath, sources, sourceStatus: payload.sourceStatus, urls, eventIds };
    await atomicJSON(join(RECEIPTS, `${id}.json`), receipt);
    return { status: 'staged', receiptId: id, digestPath, instruction: 'Output this exact file as a normal final reply. Success is recorded only when a later run verifies that final reply.' };
  } finally { await release(runId); }
}

async function main() {
  if (args[0] === 'prepare') return prepare();
  if (args[0] === 'stage') return stage();
  if (args[0] === 'reconcile') { await reconcile(); return { status: 'reconciled' }; }
  throw new Error('Usage: daily-digest.js prepare | stage --input FILE --digest FILE --sources x,blogs,podcasts --thread-id ID | reconcile');
}
if (process.argv[1] === new URL(import.meta.url).pathname) main().then(r => console.log(JSON.stringify(r, null, 2))).catch(error => { console.error(JSON.stringify({ status: 'error', message: error.message })); process.exitCode = 1; });
