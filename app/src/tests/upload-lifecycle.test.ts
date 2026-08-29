import assert from "node:assert/strict";
import test from "node:test";

import {
  canCommitUploadCompletion,
  shouldAutoOpenUploadReview,
} from "../upload-lifecycle";

test("a blurred upload commits its result without auto-opening review", () => {
  assert.equal(canCommitUploadCompletion({
    mounted: true,
    currentSubmitToken: 4,
    submitToken: 4,
  }), true);
  assert.equal(shouldAutoOpenUploadReview({
    focused: false,
    currentFocusEpoch: 2,
    submitFocusEpoch: 1,
  }), false);
});
