#!/usr/bin/env node

// ============================================================================
// Follow Builders — Prepare Digest
// ============================================================================
// Gathers everything the LLM needs to produce a digest:
// - Fetches the central feeds (tweets + podcasts)
// - Fetches the latest prompts from GitHub
// - Reads the user's config (language, delivery method)
// - Outputs a single JSON blob to stdout
//
// The LLM's ONLY job is to read this JSON, remix the content, and output
// the digest text. Everything else is handled here deterministically.
//
// Usage: node prepare-digest.js
// Output: JSON to stdout
// ============================================================================

import { readFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { fetchLocalBlogs } from './fetch-local-blogs.js';
import { fetchLocalPodcasts } from './fetch-local-podcasts.js';
import { MODULES, moduleFor, buildReport } from './digest-report.js';
import { inspectFeed, usable } from './feed-health.js';

// -- Constants ---------------------------------------------------------------

const USER_DIR = process.env.FOLLOW_BUILDERS_USER_DIR || join(homedir(), '.follow-builders');
const CONFIG_PATH = join(USER_DIR, 'config.json');

const FEED_X_URL = 'https://raw.githubusercontent.com/oliviawei36-rgb/follow-builders/main/feed-x.json';
// Podcast transcription is maintained by the upstream project. Keep X on the
// user fork for custom accounts, but consume the upstream podcast feed so this
// installation does not need a private POD2TXT_API_KEY.
const FEED_PODCASTS_URL = 'https://raw.githubusercontent.com/zarazhangrui/follow-builders/main/feed-podcasts.json';
const FEED_BLOGS_URL = 'https://raw.githubusercontent.com/oliviawei36-rgb/follow-builders/main/feed-blogs.json';

const PROMPTS_BASE = 'https://raw.githubusercontent.com/oliviawei36-rgb/follow-builders/main/prompts';
const PROMPT_FILES = [
  'summarize-podcast.md',
  'summarize-tweets.md',
  'summarize-blogs.md',
  'digest-intro.md',
  'translate.md'
];
const REMOTE_FETCH_TIMEOUT_MS = Number(
  process.env.FOLLOW_BUILDERS_REMOTE_TIMEOUT_MS || 8000
);
const LOCAL_BLOGS_TIMEOUT_MS = Number(
  process.env.FOLLOW_BUILDERS_LOCAL_TIMEOUT_MS || 45000
);

// -- Fetch helpers -----------------------------------------------------------

export async function fetchJSON(url, timeoutMs = REMOTE_FETCH_TIMEOUT_MS) {
  try {
    const requestUrl = url.startsWith('https://raw.githubusercontent.com/') ? `${url}${url.includes('?') ? '&' : '?'}fb=${Date.now()}` : url;
    const res = await fetch(requestUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function fetchText(url, timeoutMs = REMOTE_FETCH_TIMEOUT_MS) {
  try {
    const requestUrl = url.startsWith('https://raw.githubusercontent.com/') ? `${url}${url.includes('?') ? '&' : '?'}fb=${Date.now()}` : url;
    const res = await fetch(requestUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

// -- Main --------------------------------------------------------------------

export async function main({ excludeSources = [], emit = true } = {}) {
  const errors = [];

  // 1. Read user config
  let config = {
    language: 'en',
    frequency: 'daily',
    delivery: { method: 'stdout' }
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      errors.push(`Could not read config: ${err.message}`);
    }
  }

  // 2. Fetch all three feeds
  const [feedX, feedPodcasts, feedBlogs, localBlogFeed, localPodcastFeed, xHealthFeed] = await Promise.all([
    excludeSources.includes('x') ? null : fetchJSON(FEED_X_URL),
    excludeSources.includes('podcasts') ? null : fetchJSON(FEED_PODCASTS_URL),
    excludeSources.includes('blogs') ? null : fetchJSON(FEED_BLOGS_URL),
    excludeSources.includes('blogs') ? { blogs: [], errors: [] } : fetchLocalBlogs({ signal: AbortSignal.timeout(LOCAL_BLOGS_TIMEOUT_MS) }),
    excludeSources.includes('podcasts') ? { podcasts: [], errors: [], sourceHealth: [] } : fetchLocalPodcasts({ signal: AbortSignal.timeout(LOCAL_BLOGS_TIMEOUT_MS) }),
    excludeSources.includes('x') ? null : fetchJSON('https://raw.githubusercontent.com/oliviawei36-rgb/follow-builders/main/health-x.json')
  ]);

  if (!feedX) errors.push('Could not fetch tweet feed');
  if (!feedPodcasts) errors.push('Could not fetch podcast feed');
  if (!feedBlogs) errors.push('Could not fetch blog feed');
  if (feedX?.errors?.length) {
    errors.push(
      ...feedX.errors.map((error) => `Tweet feed problem: ${error}`)
    );
  }
  if (feedPodcasts?.errors?.length) {
    errors.push(
      ...feedPodcasts.errors.map((error) => `Podcast feed problem: ${error}`)
    );
  }
  if (feedBlogs?.errors?.length) {
    errors.push(
      ...feedBlogs.errors.map((error) => `Blog feed problem: ${error}`)
    );
  }
  if (localBlogFeed?.errors?.length) {
    errors.push(...localBlogFeed.errors);
  }

  errors.push(...(localPodcastFeed?.errors || []));
  const sourceStatus = {
    x: inspectFeed(feedX, 'x'),
    podcasts: inspectFeed(feedPodcasts, 'podcasts'),
    blogs: inspectFeed(feedBlogs, 'blogs')
  };
  if (localBlogFeed?.blogs?.length) {
    sourceStatus.blogs = { status: localBlogFeed.errors?.length ? 'partial' : 'ok', generatedAt: new Date().toISOString(), reason: localBlogFeed.errors?.join('; ') };
  }
  const upstreamPodcasts = usable(sourceStatus.podcasts) ? feedPodcasts.podcasts : [];
  if (localPodcastFeed?.podcasts?.length) sourceStatus.podcasts = { status: localPodcastFeed.errors?.length || !usable(inspectFeed(feedPodcasts, 'podcasts')) ? 'partial' : 'ok', generatedAt: new Date().toISOString(), reason: localPodcastFeed.errors?.join('; ') };
  else if (localPodcastFeed?.errors?.length && usable(sourceStatus.podcasts)) sourceStatus.podcasts = { ...sourceStatus.podcasts, status: upstreamPodcasts.length ? 'partial' : 'error', reason: localPodcastFeed.errors.join('; ') };
  for (const source of excludeSources) sourceStatus[source] = { status: 'already_delivered' };
  for (const [source, health] of Object.entries(sourceStatus)) {
    if (['error', 'stale'].includes(health.status)) errors.push(`${source}: ${health.reason}`);
  }
  const currentX = usable(sourceStatus.x) ? feedX.x : [];
  const currentPodcasts = [...upstreamPodcasts, ...(localPodcastFeed?.podcasts || [])];
  const mergedBlogs = [];
  const seenBlogUrls = new Set();
  for (const article of [
    ...(usable(inspectFeed(feedBlogs, 'blogs')) ? feedBlogs.blogs : []),
    ...(localBlogFeed?.blogs || [])
  ]) {
    if (!article?.url || seenBlogUrls.has(article.url)) continue;
    seenBlogUrls.add(article.url);
    mergedBlogs.push(article);
  }

  const scriptRoot = decodeURIComponent(new URL('..', import.meta.url).pathname);
  const defaults = JSON.parse(await readFile(join(scriptRoot, 'config/default-sources.json'), 'utf8'));
  const localSources = JSON.parse(await readFile(join(scriptRoot, 'config/local-sources.json'), 'utf8'));
  const activeConfig = { ...defaults, blogs: [...defaults.blogs, ...localSources.blogs] };
  for (const article of mergedBlogs) article.module = moduleFor(article.name, activeConfig);
  for (const episode of currentPodcasts) episode.module = 'AI播客';
  const remoteBlogHealth = feedBlogs?.sourceHealth || defaults.blogs.map(source => {
    const problems = (feedBlogs?.errors || []).filter(error => error.includes(source.name) || error.includes(source.indexUrl));
    return {name:source.name, status: !usable(inspectFeed(feedBlogs,'blogs')) ? 'error' : problems.length ? 'partial' : 'unverified', reason: problems.join('; ') || (!usable(inspectFeed(feedBlogs,'blogs')) ? 'Blog feed unavailable or stale' : 'Shared feed does not provide per-source fetch outcomes')};
  });
  const sharedPodcastHealth = defaults.podcasts.filter(source=>source.fetchMethod!=='public').map(source => ({ name:source.name, module:'AI播客', status: !usable(inspectFeed(feedPodcasts,'podcasts')) ? 'error' : upstreamPodcasts.some(episode=>episode.name===source.name) ? 'ok' : 'unverified', reason: !usable(inspectFeed(feedPodcasts,'podcasts')) ? 'Shared podcast feed unavailable or stale' : 'Shared feed does not provide per-podcast fetch outcomes' }));
  const xRecords = xHealthFeed?.sources && Date.now()-Date.parse(xHealthFeed.generatedAt)<30*3600000 ? xHealthFeed.sources : defaults.x_accounts.map(source=>({name:source.name,module:'X',status:usable(sourceStatus.x) ? 'unverified':'error',reason:usable(sourceStatus.x) ? 'Shared feed does not provide per-account fetch outcomes' : 'Twitter feed unavailable or stale'}));
  const healthReport = buildReport({ config:activeConfig, records:[...xRecords,...remoteBlogHealth,...(localBlogFeed?.sourceHealth || []),...sharedPodcastHealth,...(localPodcastFeed?.sourceHealth || [])], excluded:excludeSources });

  // 3. Load prompts with priority: user custom > remote (GitHub) > local default
  //
  // If the user has a custom prompt at ~/.follow-builders/prompts/<file>,
  // use that (they personalized it — don't overwrite with remote updates).
  // Otherwise, fetch the latest from GitHub so they get central improvements.
  // If GitHub is unreachable, fall back to the local copy shipped with the skill.
  const prompts = {};
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  const localPromptsDir = join(scriptDir, '..', 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');

  async function loadPrompt(filename) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);

    // Priority 1: user's custom prompt (they personalized it)
    if (existsSync(userPath)) {
      return [key, await readFile(userPath, 'utf-8')];
    }

    // Priority 2: latest from GitHub (central updates)
    const remote = await fetchText(`${PROMPTS_BASE}/${filename}`);
    if (remote) {
      return [key, remote];
    }

    // Priority 3: local copy shipped with the skill
    if (existsSync(localPath)) {
      return [key, await readFile(localPath, 'utf-8')];
    } else {
      errors.push(`Could not load prompt: ${filename}`);
      return [key, null];
    }
  }

  const promptEntries = await Promise.all(PROMPT_FILES.map(loadPrompt));
  for (const [key, value] of promptEntries) {
    if (value) prompts[key] = value;
  }

  // 4. Build the output — everything the LLM needs in one blob
  const output = {
    status: Object.values(sourceStatus).some(h => ['error', 'stale', 'partial'].includes(h.status)) ? 'degraded' : 'ok',
    sourceStatus,
    moduleOrder: MODULES,
    healthReport,
    generatedAt: new Date().toISOString(),

    // User preferences
    config: {
      language: config.language || 'en',
      frequency: config.frequency || 'daily',
      delivery: config.delivery || { method: 'stdout' }
    },

    // Content to remix
    podcasts: currentPodcasts,
    x: currentX,
    blogs: mergedBlogs,

    // Stats for the LLM to reference
    stats: {
      podcastEpisodes: currentPodcasts.length,
      xBuilders: currentX.length,
      totalTweets: currentX.reduce((sum, a) => sum + (a.tweets?.length || 0), 0),
      blogPosts: mergedBlogs.length,
      feedGeneratedAt: feedX?.generatedAt || feedPodcasts?.generatedAt || feedBlogs?.generatedAt || null
    },

    // Prompts — the LLM reads these and follows the instructions
    prompts,

    // Non-fatal errors
    errors: errors.length > 0 ? errors : undefined
  };

  if (emit) console.log(JSON.stringify(output, null, 2));
  return output;
}

if (process.argv[1] === decodeURIComponent(new URL(import.meta.url).pathname)) {
  main().catch(err => {
    console.error(JSON.stringify({
      status: 'error',
      message: err.message
    }));
    process.exit(1);
  });
}
