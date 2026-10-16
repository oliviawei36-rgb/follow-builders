// Feed availability is independent from whether today's feed contains new items.
export function shanghaiDate(value = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
}

export function inspectFeed(feed, key, now = new Date()) {
  if (!feed || !Array.isArray(feed[key])) return { status: 'error', reason: 'Feed unavailable or invalid', generatedAt: null };
  const generated = new Date(feed.generatedAt);
  const age = new Date(now) - generated;
  const maxAge = key === 'podcasts' ? 21 * 86400000 : 30 * 3600000;
  if (!Number.isFinite(age) || age < -300000 || age > maxAge || (key === 'x' && shanghaiDate(generated) !== shanghaiDate(now))) {
    return { status: 'stale', reason: 'Feed is not current', generatedAt: feed.generatedAt ?? null };
  }
  if (feed.errors?.length) return { status: feed[key].length ? 'partial' : 'error', reason: feed.errors.join('; '), generatedAt: feed.generatedAt };
  return { status: feed[key].length ? 'ok' : 'empty', generatedAt: feed.generatedAt };
}
export const usable = (health) => ['ok', 'empty', 'partial'].includes(health?.status);
