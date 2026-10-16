import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectFeed, shanghaiDate } from './feed-health.js';
const exec = promisify(execFile);
const dir = dirname(new URL(import.meta.url).pathname);

test('stale and failed feeds differ from a successful empty feed', () => {
  const now = new Date('2026-10-16T00:00:00Z');
  assert.equal(inspectFeed({ generatedAt: '2026-07-24T00:00:00Z', x: [] }, 'x', now).status, 'stale');
  assert.equal(inspectFeed({ generatedAt: '2026-10-15T23:15:00Z', x: [] }, 'x', now).status, 'empty');
  assert.equal(inspectFeed(null, 'x', now).status, 'error');
  assert.equal(inspectFeed({ generatedAt: '2026-10-15T23:15:00Z', x: [], errors: ['HTTP 402'] }, 'x', now).status, 'error');
});
test('a previous calendar day cannot masquerade as today at 08:00', () => {
  assert.equal(inspectFeed({ generatedAt: '2026-10-14T23:15:00Z', x: [] }, 'x', new Date('2026-10-16T00:00:00Z')).status, 'stale');
});
test('staging does not record delivery; only an actual final response does', async () => {
  const root = await mkdtemp(join(tmpdir(), 'follow-builders-test-'));
  const database = join(root, 'state.sqlite');
  const rollout = join(root, 'thread.jsonl');
  await writeFile(rollout, '');
  await exec('python3', ['-c', "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table threads (id text, rollout_path text)'); c.execute('insert into threads values (?,?)',('test-thread',sys.argv[2])); c.commit()", database, rollout]);
  const env = { ...process.env, FOLLOW_BUILDERS_USER_DIR: root, FOLLOW_BUILDERS_CODEX_STATE_DB: database };
  const run = async (...args) => JSON.parse((await exec(process.execPath, [join(dir, 'daily-digest.js'), ...args], { env })).stdout);
  const input = join(root, 'input.json'); const digest = join(root, 'digest.md');
  const payload = { sourceStatus: { x: { status: 'ok', generatedAt: new Date().toISOString() }, blogs: { status: 'error' }, podcasts: { status: 'error' } }, x: [{ tweets: [{ url: 'https://x.com/test/status/1' }] }] };
  await writeFile(input, JSON.stringify(payload)); await writeFile(digest, '# Test digest\nA real update.');
  await run('stage', '--input', input, '--digest', digest, '--sources', 'x', '--thread-id', 'test-thread');
  assert.equal((await run('stage', '--input', input, '--digest', digest, '--sources', 'x', '--thread-id', 'test-thread')).status, 'already_staged');
  await run('reconcile');
  await assert.rejects(readFile(join(root, 'delivery-state.json')));
  const message = phase => JSON.stringify({ timestamp: new Date(Date.now() + 1000).toISOString(), type: 'response_item', payload: { type: 'message', role: 'assistant', phase, id: 'message-1', content: [{ text: '# Test digest\nA real update.' }] } }) + '\n';
  await writeFile(rollout, message('commentary'));
  await run('reconcile');
  await assert.rejects(readFile(join(root, 'delivery-state.json')));
  await writeFile(rollout, message('final_answer'));
  await run('reconcile');
  const state = JSON.parse(await readFile(join(root, 'delivery-state.json')));
  assert.equal(state.deliveredDates[shanghaiDate()].sources.x.status, 'delivered');
  assert.equal(state.deliveredDates[shanghaiDate()].status, 'partial');
  assert.equal(state.deliveredDates[shanghaiDate()].sources.blogs, undefined);
  assert.equal((await run('prepare', '--sources', 'x', '--force')).status, 'already_delivered');
  await assert.rejects(run('stage', '--input', input, '--digest', digest, '--sources', 'blogs', '--thread-id', 'test-thread'));
});

test('08:00 gate resumes after offline time and ignores legacy whole-day success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'follow-builders-resume-'));
  const date = shanghaiDate();
  await writeFile(join(root, 'delivery-state.json'), JSON.stringify({ deliveredDates: { [date]: { status: 'success' } } }));
  const preload = join(root, 'fetch.mjs');
  await writeFile(preload, `globalThis.fetch = async (url) => ({ ok: true, json: async () => ({ generatedAt: new Date().toISOString(), x: [{ handle:'example', tweets:[{url:'https://x.com/example/status/7'}] }] }), text: async () => 'Prompt' });`);
  const run = async now => JSON.parse((await exec(process.execPath, ['--import', preload, join(dir, 'daily-digest.js'), 'prepare', '--sources', 'x', '--no-refresh'], { env: { ...process.env, FOLLOW_BUILDERS_USER_DIR: root, FOLLOW_BUILDERS_NOW: `${date}T${now}+08:00` } })).stdout);
  assert.equal((await run('07:59:00')).status, 'before_delivery_time');
  const resumed = await run('08:00:00');
  assert.equal(resumed.status, 'ready');
  assert.deepEqual(resumed.sources, ['x']);
  const input = JSON.parse(await readFile(resumed.inputPath));
  assert.equal(input.x[0].tweets.length, 1);
});
