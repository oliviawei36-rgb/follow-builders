import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { MODULES, buildReport } from './digest-report.js';
import { parseFirstEpisode, fetchLocalPodcasts } from './fetch-local-podcasts.js';

test('failure-only opening excludes successfully empty and unverified sources',()=>{
 const config={x_accounts:[{name:'One'},{name:'Two'}],podcasts:[{name:'Three'}],blogs:[{name:'Four',module:'法律 AI 产品'}]};
 const report=buildReport({config,records:[{name:'One',status:'no_updates'},{name:'Two',status:'error',reason:'HTTP 402'},{name:'Three',status:'unverified'},{name:'Four',status:'partial',reason:'One article failed'}]});
 assert.deepEqual(report.failures.map(s=>s.name),['Two','Four']);
 assert.deepEqual(report.moduleOrder,['X','AI播客','AI 公司博客及产品更新','法律 AI 产品','律所与法务AI实践','中国大模型厂商资讯']);
});
test('requested source removals and podcast additions are effective',async()=>{
 const local=JSON.parse(await readFile(new URL('../config/local-sources.json',import.meta.url)));
 const defaults=JSON.parse(await readFile(new URL('../config/default-sources.json',import.meta.url)));
 assert.equal(local.blogs.length+defaults.blogs.length,29);
 assert.equal(defaults.podcasts.length,8);
 assert.ok(!local.blogs.some(s=>s.name.startsWith('中国法律科技｜') || s.name.includes('百度千帆')));
 assert.ok(local.podcasts.some(s=>s.name==='Lex Fridman Podcast'));
 assert.ok(local.podcasts.some(s=>s.name==='All-In'));
 assert.ok(local.blogs.every(s=>MODULES.includes(s.module)));
});
test('a complete first episode can be read without downloading a huge RSS archive',()=>{
 const xml='<rss><channel><item><title><![CDATA[Episode &amp; One]]></title><link>https://example.com/episode</link><description><![CDATA[Show notes]]></description><pubDate>Fri, 16 Oct 2026 00:00:00 GMT</pubDate></item><item><description><![CDATA[unfinished archive';
 const item=parseFirstEpisode(xml,{name:'Fixture'});
 assert.equal(item.title,'Episode & One');assert.equal(item.transcriptAvailable,false);assert.equal(item.contentType,'show_notes');
});
test('missing publisher transcript is distinct from a failed transcript request',async()=>{
 const xml=(link='')=>`<rss><channel><item><title>Fixture</title><link>https://example.com/item</link><description><![CDATA[Episode notes ${link}]]></description><pubDate>Fri, 16 Oct 2026 00:00:00 GMT</pubDate></item></channel></rss>`;
 const result=await fetchLocalPodcasts({sources:[{name:'No transcript',rssUrl:'https://example.com/notes'},{name:'Failed transcript',rssUrl:'https://example.com/with-transcript'}],fetcher:async url=>{
   if(url.includes('lexfridman.com'))throw new Error('HTTP 503');
   return xml(url.endsWith('with-transcript') ? 'https://lexfridman.com/fixture-transcript':'');
 }});
 assert.equal(result.sourceHealth.find(s=>s.name==='No transcript').status,'ok');
 assert.equal(result.sourceHealth.find(s=>s.name==='Failed transcript').status,'partial');
 assert.equal(result.podcasts.length,2);
});
