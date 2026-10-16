import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoveryPlan, mergeDiscovery, parseSearchFeed } from './discovery.js';
import { fetchLocalBlogs, matchesKeywords, isRecent, extractArticle } from './fetch-local-blogs.js';
const now = new Date('2026-10-16T12:00:00Z');
const query = { id:'models-en', name:'主题补漏｜模型', module:'AI 公司博客及产品更新' };
const payload = () => ({ discovery:{ queries:[query],lookbackDays:90,date:'2026-10-16' },blogs:[],stats:{},sourceStatus:{blogs:{status:'ok'}},healthReport:{sources:[],failures:[]} });

test('first discovery looks back 90 days; later days use 14 days and same day reuses result', async () => {
  const root=await mkdtemp(join(tmpdir(),'fb-discovery-'));
  assert.equal((await discoveryPlan({root,now})).lookbackDays,90);
  await writeFile(join(root,'discovery-state.json'),JSON.stringify({initialComplete:true,date:'2026-10-16',result:{queries:[]}}));
  assert.equal((await discoveryPlan({root,now})).completed,true);
  assert.equal((await discoveryPlan({root,now:new Date('2026-10-17T12:00:00Z')})).lookbackDays,14);
});
test('successful empty search is not a failure; failed search remains explicit',()=>{
  const a=mergeDiscovery(payload(),{queries:[{id:'models-en',status:'ok'}],articles:[]});
  assert.deepEqual(a.healthReport.failures,[]);
  const b=mergeDiscovery(payload(),{queries:[{id:'models-en',status:'error',reason:'Unavailable'}],articles:[]});
  assert.equal(b.healthReport.failures[0].reason,'Unavailable');
  assert.equal(b.sourceStatus.blogs.status,'partial');
});
test('missing outcomes and unverified snippets cannot complete discovery',()=>{
  assert.throws(()=>mergeDiscovery(payload(),{queries:[]}));
  assert.throws(()=>mergeDiscovery(payload(),{queries:[{id:'models-en',status:'ok'}],articles:[{title:'Snippet',url:'https://example.com'}]}));
});
test('event groups merge mirrors and previously delivered events stay suppressed',()=>{
  const p=payload();p.blogs=[{url:'https://example.com/en'},{url:'https://example.com/zh'}];
  const result={queries:[{id:'models-en',status:'ok'}],eventGroups:[{eventId:'example:model:1:release',urls:p.blogs.map(x=>x.url)}]};
  assert.equal(mergeDiscovery(p,result).blogs.length,1);
  const old=payload();old.deliveredEventIds=['example:model:1:release'];old.blogs=[{url:'https://example.com/en'}];
  assert.equal(mergeDiscovery(old,result).blogs.length,0);
});
test('model releases pass without legal keywords but token promotions do not',()=>{
  const s={includeModelReleases:true,includeKeywords:['法律','legal','law']};
  assert.equal(matchesKeywords({title:'GLM-5.3-Flash',description:'Introducing a new multimodal model',content:''},s),true);
  assert.equal(matchesKeywords({title:'AutoClaw login token giveaway',description:'',content:'Get free tokens'},s),false);
  assert.equal(matchesKeywords({title:'New legal model',description:'',content:'Contract review'},s),true);
});
test('90-day backfill finds month-old launches that daily 14-day scan excludes',()=>{
  assert.equal(isRecent('2026-09-15',90,now.getTime()),true);
  assert.equal(isRecent('2026-09-15',14,now.getTime()),false);
  assert.equal(isRecent('2027-01-01',90,now.getTime()),false);
});
test('visible publisher date is preserved instead of treating old articles as current',()=>{
  const a=extractArticle('<main><h1>Introducing Jev</h1><p>Sep 15, 2026</p><p>Official model release</p></main>','https://example.com','Example');
  assert.equal(a.publishedAt.slice(0,10),'2026-09-15');
});
test('search HTML failure is not recorded as an empty successful RSS search',()=>{
  assert.throws(()=>parseSearchFeed('<html>Blocked</html>',query));
  assert.equal(parseSearchFeed('<rss><channel></channel></rss>',query).length,0);
});
test('per-source initial window retries on failure and switches only after success', async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fb-source-'));const path=join(dir,'state.json');
  const sources=[{name:'Example',feedUrl:'https://example.com/feed',articlePrefixes:['https://example.com/'],module:query.module}];
  const original=globalThis.fetch;
  try {
    globalThis.fetch=async()=>({ok:true,text:async()=>'<rss><item><title>Release</title><link>https://example.com/release</link><pubDate>2026-09-15</pubDate><description>Official model release</description></item></rss>'});
    const first=await fetchLocalBlogs({sources,statePath:path,now:now.getTime()});assert.equal(first.blogs.length,1);assert.equal(first.sourceHealth[0].lookbackDays,90);
    const second=await fetchLocalBlogs({sources,statePath:path,now:now.getTime()});assert.equal(second.blogs.length,0);assert.equal(second.sourceHealth[0].lookbackDays,14);
    assert.equal(JSON.parse(await readFile(path,'utf8')).__coverage.Example.initialComplete,true);
  } finally {globalThis.fetch=original;}
});

test('verified discoveries remain deliverable when subscribed feeds fail',()=>{
  const p=payload();p.sourceStatus.blogs={status:'error',reason:'Site unavailable'};
  const article={queryId:'models-en',title:'Verified release',url:'https://example.com/release',publishedAt:new Date().toISOString(),content:'Official release content',module:'AI 公司博客及产品更新',verification:'official',evidence:'Inspected official publisher',eventId:'example:model:1:release'};
  const result=mergeDiscovery(p,{queries:[{id:'models-en',status:'ok'}],articles:[article]});
  assert.equal(result.sourceStatus.blogs.status,'partial');assert.equal(result.blogs.length,1);
});
