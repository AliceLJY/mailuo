import assert from "node:assert/strict";
import test from "node:test";

import { shouldPreserveBatchOnReset } from "../flow-context";

test("connection changes preserve both active and completed batch results", () => {
  assert.equal(
    shouldPreserveBatchOnReset([{ status: "processing" }], false),
    true,
  );
  assert.equal(
    shouldPreserveBatchOnReset(
      [{ status: "success" }, { status: "failure" }],
      true,
      { preserveExistingBatch: true },
    ),
    true,
  );
  assert.equal(
    shouldPreserveBatchOnReset([], false, { preserveExistingBatch: true }),
    false,
  );
  assert.equal(
    shouldPreserveBatchOnReset([{ status: "success" }], true),
    false,
  );
});
