# Model release discovery

Run this before remixing a daily digest that includes blogs. This is the explicit
exception to the ordinary JSON-only remix rule. Do not perform unrelated research.

The prepared payload includes `discovery`: the search date, lookback window,
queries and optional cloud search leads. Cloud leads and search snippets are
unverified. Search every configured query using the available web search tool,
using the plan's lookback window (first successful sweep: 90 days; later: 14 days).
Search globally, including publishers outside the subscription list. Refine broad
queries when needed; do not treat a single ranked results page as exhaustive.

For worthwhile model or legal AI releases, open the official publisher's release,
product documentation or repository. Record the original publication date. Avoid
repeating vendor performance claims as independently tested facts. General model
releases can qualify without legal keywords when capabilities affect software,
structured decisions, document handling, tools or agents.

Save one results JSON with this schema (replace all illustrative values):

```json
{
  "queries": [
    {"id": "models-en", "status": "ok"},
    {"id": "legal-en", "status": "ok"},
    {"id": "models-zh", "status": "ok"},
    {"id": "legal-zh", "status": "error", "reason": "Search service unavailable"}
  ],
  "articles": [
    {
      "queryId": "models-en",
      "name": "Publisher official release",
      "title": "Verified release title",
      "url": "https://publisher.example/release",
      "publishedAt": "2026-10-16T00:00:00Z",
      "content": "Verified text from the official page, not the search snippet.",
      "module": "AI 公司博客及产品更新",
      "verification": "official",
      "evidence": "Official publisher page and publication date inspected.",
      "eventId": "publisher:model:version:release"
    }
  ],
  "eventGroups": [
    {"eventId": "publisher:model:version:release", "urls": ["https://publisher.example/release", "https://publisher.example/translated-release"]}
  ]
}
```

Every planned query needs a real outcome. An empty successful search is `ok` with
no articles; a failed or unattempted search is `error` with a short reason. Never
label an unattempted search successful. Preserve the same eventId across languages,
mirrors and later rediscovery, but distinguish different versions and releases.
Use eventGroups to group both discovered and already subscribed articles about
the same event. Prefer one official source per event. Exclude deliveredEventIds and
deliveredBlogUrls already present in the payload. Do not reinstate sources the
user explicitly removed.

Run:

```sh
node scripts/discovery.js complete --input <inputPath> --results <results.json>
```

The command re-fetches the official pages, checks dates, merges results, records
search outcomes and event identities, and updates the payload. Read the updated
input before generating and staging the digest. Staging blogs is blocked until
discovery is completed; explicitly failed searches allow a partial digest and are
reported only as failures in the opening line. Cache successful daily discovery
so half-hour retries do not repeat searches. Each source retains its initial
90-day window until its first successful scan; incomplete scans must retry.

Keep the six existing modules. Chinese model vendors go into
`中国大模型厂商资讯`; TypeSafe into `AI 公司博客及产品更新`. A watch-page timestamp means
change observed now, not that every model listed on that page launched today.
The rolling window covers discoverable index/feed/sitemap entries, not a promise
that every historical post on the internet was scanned.
