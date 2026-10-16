import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
const DIR = dirname(new URL(import.meta.url).pathname);
const CACHE = join(process.env.FOLLOW_BUILDERS_USER_DIR || join(homedir(), '.follow-builders'), 'podcast-cache');

export function clean(text = '') {
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<\/(p|div|h[1-6])>|<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n,16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n\n').trim();
}
const field = (xml, tag) => xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1] || '';
export function parseFirstEpisode(xml, source) {
  const item = xml.match(/<item\b[^>]*>([\s\S]*?)<\/item>/i)?.[1];
  if (!item) throw new Error('RSS did not contain a complete episode');
  const rawNotes = field(item, 'content:encoded') || field(item, 'description');
  const notes = clean(rawNotes);
  const date = new Date(clean(field(item, 'pubDate')));
  const url = clean(field(item, 'link'));
  if (!url.startsWith('https://')) throw new Error('Episode has no valid original URL');
  const transcriptUrl = rawNotes.match(/https:\/\/lexfridman\.com\/[^\s<"']+-transcript\/?/i)?.[0] || item.match(/<podcast:transcript\b[^>]*url=["']([^"']+)/i)?.[1] || null;
  return { source:'podcast', name:source.name, module:'AI播客', title:clean(field(item,'title')), url, guid:clean(field(item,'guid')) || url, publishedAt:Number.isFinite(date.getTime()) ? date.toISOString() : null, description:notes, showNotes:notes, transcriptUrl, coverage:source.coverage || 'curated', transcriptAvailable:false, contentType:'show_notes' };
}
export async function fetchStream(url, { signal, firstItem = false } = {}) {
  const timeout = AbortSignal.timeout(18000);
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal,timeout]) : timeout, headers:{'User-Agent':'Mozilla/5.0 (compatible; FollowBuilders/1.0)'} });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const reader=response.body.getReader(); const decoder=new TextDecoder(); let text='';
  try {
    while (true) {
      const { value, done }=await reader.read(); if (done) break;
      text+=decoder.decode(value,{stream:true});
      if (firstItem && text.includes('</item>')) break;
      if (!firstItem && /<\/article>/i.test(text)) break;
      if (text.length>1500000) throw new Error('Response exceeds safe content limit');
    }
  } finally { await reader.cancel(); }
  return text;
}
export async function fetchLocalPodcasts({ signal, fetcher = fetchStream, sources } = {}) {
  if (!sources) sources=JSON.parse(await readFile(join(DIR,'../config/local-sources.json'),'utf8')).podcasts || [];
  const podcasts=[], errors=[], sourceHealth=[];
  await mkdir(CACHE,{recursive:true});
  await Promise.all(sources.map(async source => {
    const health={ name:source.name, module:'AI播客', checkedAt:new Date().toISOString(), status:'error', count:0 };
    try {
      const episode=parseFirstEpisode(await fetcher(source.rssUrl,{signal,firstItem:true}),source);
      const cachePath=join(CACHE,`${source.name.replace(/[^a-z0-9]/gi,'-')}.json`);
      let cached; try { cached=JSON.parse(await readFile(cachePath,'utf8')); } catch {}
      if (cached?.guid===episode.guid && cached.transcriptAvailable) Object.assign(episode,{ transcript:cached.transcript, transcriptAvailable:true, contentType:'transcript' });
      else if (episode.transcriptUrl) {
        try {
          const html=await fetcher(episode.transcriptUrl,{signal});
          const body=html.match(/<div\b[^>]*class=["'][^"']*entry-content[^"']*["'][^>]*>([\s\S]*?)<\/article>/i)?.[1] || html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1];
          const transcript=clean(body || '');
          if (transcript.length<1000) throw new Error('Official transcript content could not be extracted');
          Object.assign(episode,{transcript,transcriptAvailable:true,contentType:'transcript'});
        } catch(error) { health.status='partial'; health.reason=`Episode retrieved; transcript fetch failed: ${error.message}`; errors.push(`${source.name} transcript: ${error.message}`); }
      }
      health.status=health.status==='partial' ? 'partial' : 'ok'; health.count=1;health.contentType=episode.contentType;
      if (!episode.transcriptUrl) health.note='Publisher RSS provides episode notes but no transcript link';
      await writeFile(cachePath,JSON.stringify(episode),{mode:0o600});
      podcasts.push(episode);
    } catch(error) { health.reason=error.message;errors.push(`${source.name}: ${error.message}`); }
    sourceHealth.push(health);
  }));
  return {podcasts,errors,sourceHealth};
}
if (process.argv[1]===new URL(import.meta.url).pathname) fetchLocalPodcasts().then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1;});
