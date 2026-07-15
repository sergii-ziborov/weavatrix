import test from "node:test";
import assert from "node:assert/strict";
import { childProcessEnv } from "../src/child-env.js";

test("child environments never inherit the graph sync bearer token", () => {
  const previous = process.env.WEAVATRIX_SYNC_TOKEN;
  process.env.WEAVATRIX_SYNC_TOKEN = "host-secret";
  try {
    const env = childProcessEnv({ WEAVATRIX_SYNC_TOKEN: "override-secret", WEAVATRIX_TEST_VALUE: "kept" });
    assert.equal(env.WEAVATRIX_SYNC_TOKEN, undefined);
    assert.equal(env.WEAVATRIX_TEST_VALUE, "kept");
  } finally {
    if (previous == null) delete process.env.WEAVATRIX_SYNC_TOKEN;
    else process.env.WEAVATRIX_SYNC_TOKEN = previous;
  }
});
