import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchXContent } from './generate-feed.js';

const state = () => ({ seenTweets: {}, seenVideos: {}, seenArticles: {}, xUsers: {}, xSinceIds: {} });
const account = { handle: 'Example', name: 'Example Builder' };
const response = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
async function withFetch(mock, run) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try { await run(); } finally { globalThis.fetch = original; }
}
test('cached IDs avoid paid profile reads and cursors request only newer posts', async () => {
  const s = state();
  s.xUsers.example = { id: '42', description: 'Builder' };
  s.xSinceIds.example = '100';
  await withFetch(async url => {
    assert.match(url, /users\/42\/tweets/);
    assert.match(url, /since_id=100/);
    return response({ data: [] });
  }, async () => {
    const result = await fetchXContent([account], 'test-token', s, []);
    assert.deepEqual(result, []);
    assert.equal(s.lastXRequestStats.userLookupRequests, 0);
    assert.equal(s.lastXRequestStats.timelineRequests, 1);
  });
});
test('new profiles are cached and all five paid posts are retained', async () => {
  const s = state();
  await withFetch(async url => url.includes('/users/by?')
    ? response({ data: [{ username: 'Example', id: '42', name: 'Example', description: 'Builder' }] })
    : response({ data: [5,4,3,2,1].map(id => ({ id: String(id), text: 'Post', created_at: new Date().toISOString() })) }), async () => {
    const result = await fetchXContent([account], 'test-token', s, []);
    assert.equal(result[0].tweets.length, 5);
    assert.equal(s.xUsers.example.id, '42');
    assert.equal(s.xSinceIds.example, '5');
    assert.equal(s.lastXRequestStats.userResourcesRead, 1);
  });
});
test('failed timeline requests preserve both cursor and cached profile', async () => {
  const s = state();
  s.xUsers.example = { id: '42' };
  s.xSinceIds.example = '100';
  const errors = [];
  await withFetch(async () => response({}, 402), async () => {
    await fetchXContent([account], 'test-token', s, errors);
    assert.equal(s.xSinceIds.example, '100');
    assert.equal(s.xUsers.example.id, '42');
    assert.match(errors[0], /402/);
  });
});
test('account-wide billing failures stop further paid lookup attempts', async () => {
  const s = state(); let calls = 0;
  await withFetch(async () => { calls++; return response({}, 402); }, async () => {
    await fetchXContent(Array.from({ length: 12 }, (_, i) => ({ handle: `user${i}` })), 'test-token', s, []);
    assert.equal(calls, 1);
  });
});
test('seen posts are not emitted again', async () => {
  const s = state();
  s.xUsers.example = { id: '42' }; s.seenTweets['101'] = Date.now();
  await withFetch(async () => response({ data: [{ id: '101', text: 'Old post' }] }), async () => {
    assert.deepEqual(await fetchXContent([account], 'test-token', s, []), []);
  });
});

test('incremental retries retain same-day posts without reintroducing duplicates', async () => {
  const { mergeDailyXContent } = await import('./generate-feed.js');
  const previous = { generatedAt: '2026-10-16T00:00:00Z', x: [{ handle: 'Example', tweets: [{ id: '1', text: 'One' }] }] };
  assert.equal(mergeDailyXContent(previous, [], new Date('2026-10-16T12:00:00Z'))[0].tweets.length, 1);
  assert.equal(mergeDailyXContent(previous, [{ handle: 'Example', tweets: [{ id: '1', text: 'One' }, { id: '2', text: 'Two' }] }], new Date('2026-10-16T12:00:00Z'))[0].tweets.length, 2);
  assert.deepEqual(mergeDailyXContent(previous, [], new Date('2026-10-17T00:00:00Z')), []);
});
