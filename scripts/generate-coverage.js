import { writeFile } from 'node:fs/promises';
import { fetchLocalBlogs } from './fetch-local-blogs.js';
import { fetchDiscoveryLeads } from './discovery.js';
const [sites, discovery] = await Promise.all([
  fetchLocalBlogs({ signal: AbortSignal.timeout(180000), statePath: new URL('../state-sites.json', import.meta.url).pathname }),
  fetchDiscoveryLeads({ signal: AbortSignal.timeout(45000) })
]);
const output = { generatedAt: new Date().toISOString(), ...sites, discovery };
await writeFile(new URL('../feed-coverage.json', import.meta.url), JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ articles: sites.blogs.length, failedSources: sites.sourceHealth.filter(item => ['error','partial'].includes(item.status)).map(item => item.name), searchQueries: discovery.searches.map(item => ({ id: item.id, status: item.status, candidates: item.candidates.length })) }));
