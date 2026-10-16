import { readFile, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { fetchLocalBlogs } from './fetch-local-blogs.js';
import { fetchDiscoveryLeads } from './discovery.js';
let previous = {};
try { previous = JSON.parse(await readFile(new URL('../state-sites.json', import.meta.url), 'utf8')); } catch {}
const searchDays = Object.keys(previous.__coverage || {}).length ? 14 : 90;
const [sites, discovery] = await Promise.all([
  fetchLocalBlogs({ signal: AbortSignal.timeout(180000), statePath: new URL('../state-sites.json', import.meta.url).pathname }),
  fetchDiscoveryLeads({ lookbackDays: searchDays, signal: AbortSignal.timeout(45000) })
]);
sites.blogs = sites.blogs.map(article => ({ ...article, content: article.content.slice(0, 4000), contentExcerpt: article.content.length > 4000 }));
const output = { generatedAt: new Date().toISOString(), ...sites, discovery };
await writeFile(new URL('../feed-coverage.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
await writeFile(new URL('../feed-coverage.json.gz', import.meta.url), gzipSync(JSON.stringify(output)));
console.log(JSON.stringify({ articles: sites.blogs.length, failedSources: sites.sourceHealth.filter(item => ['error','partial'].includes(item.status)).map(item => item.name), searchQueries: discovery.searches.map(item => ({ id: item.id, status: item.status, candidates: item.candidates.length })) }));
