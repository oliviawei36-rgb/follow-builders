import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { fetchJSON } from "./prepare-digest.js";

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

test("fetchJSON returns null when the remote request exceeds its deadline", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_url, { signal }) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error("test fetch did not abort")), 1000);
    signal.addEventListener("abort", () => {
      clearTimeout(keepAlive);
      reject(signal.reason);
    }, { once: true });
  });

  try {
    const startedAt = Date.now();
    assert.equal(await fetchJSON("https://example.invalid/feed.json", 25), null);
    assert.ok(Date.now() - startedAt < 500);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("prepare-digest emits valid degraded JSON when every network source times out", async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    [join(SCRIPT_DIR, "prepare-digest.js")],
    {
      env: {
        ...process.env,
        FOLLOW_BUILDERS_REMOTE_TIMEOUT_MS: "25",
        FOLLOW_BUILDERS_LOCAL_TIMEOUT_MS: "50",
        FOLLOW_BUILDERS_REQUEST_TIMEOUT_MS: "25",
      },
      timeout: 8000,
      maxBuffer: 20 * 1024 * 1024,
    },
  );

  const output = JSON.parse(stdout);
  assert.equal(output.status, "degraded");
  assert.equal(output.sourceStatus.x.status, "error");
  assert.deepEqual(output.x, []);
  assert.ok(Array.isArray(output.errors));
  assert.equal(typeof output.prompts.digest_intro, "string");
});
