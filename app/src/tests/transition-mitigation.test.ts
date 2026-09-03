import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const layoutSource = readFileSync(
  new URL("../../app/_layout.tsx", import.meta.url),
  "utf8",
);
const reviewSource = readFileSync(
  new URL("../../app/review/[screenshotId].tsx", import.meta.url),
  "utf8",
);
const uploadSource = readFileSync(
  new URL("../../app/(tabs)/index.tsx", import.meta.url),
  "utf8",
);

function sourceSection(source: string, start: string, end: string) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.notEqual(endIndex, -1, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertOrdered(source: string, snippets: string[]) {
  let previousIndex = -1;
  for (const snippet of snippets) {
    const index = source.indexOf(snippet, previousIndex + 1);
    assert.ok(index > previousIndex, `expected ordered source snippet: ${snippet}`);
    previousIndex = index;
  }
}

test("review and insights screens disable native stack animation", () => {
  assert.match(
    layoutSource,
    /name="review\/\[screenshotId\]"[\s\S]{0,120}animation: "none"/u,
  );
  assert.match(
    layoutSource,
    /name="insights"[\s\S]{0,120}animation: "none"/u,
  );
});

test("review clears its rendered card groups one frame before opening insights", () => {
  assert.match(
    reviewSource,
    /const renderedReviewGroups = reviewGroupsCleared \? \[\] : orderedGroups;/u,
  );
  assert.match(reviewSource, /renderedReviewGroups\.map/u);

  const transitionRequest = sourceSection(
    reviewSource,
    "  function scheduleInsightsTransition()",
    "  async function refreshScreenshot(",
  );
  assertOrdered(transitionRequest, [
    'logEvent("transition_start", REVIEW_TO_INSIGHTS_TRANSITION);',
    "setReviewGroupsCleared(true);",
  ]);
  const committedTransition = sourceSection(
    reviewSource,
    "  useEffect(() => {\n    if (!reviewGroupsCleared ||",
    "  function scheduleInsightsTransition()",
  );
  assertOrdered(committedTransition, [
    "requestAnimationFrame(() => {",
    'router.replace("/insights");',
    'logEvent("transition_done", REVIEW_TO_INSIGHTS_TRANSITION);',
  ]);
  const frameCallback = sourceSection(
    committedTransition,
    "requestAnimationFrame(() => {",
    "\n    });",
  );
  assert.match(frameCallback, /router\.replace\("\/insights"\);/u);
  assert.match(
    frameCallback,
    /logEvent\("transition_done", REVIEW_TO_INSIGHTS_TRANSITION\);/u,
  );
  const automaticCompletion = sourceSection(
    reviewSource,
    "  useEffect(() => {\n    if (\n      !isValidId ||",
    "  function scheduleInsightsTransition()",
  );
  assert.match(automaticCompletion, /scheduleInsightsTransition\(\);/u);
  assert.equal(
    reviewSource.match(/router\.replace\("\/insights"\);/gu)?.length ?? 0,
    1,
  );
});

test("upload clears its thumbnail draft one frame before every review push", () => {
  const transitionRequest = sourceSection(
    uploadSource,
    "  function scheduleReviewPush(screenshotId: number)",
    "  function cancelPendingReviewTransition()",
  );
  assertOrdered(transitionRequest, [
    'logEvent("transition_start", detail);',
    'dispatchDraft({ type: "reset" });',
    "setReviewTransition({ screenshotId, detail });",
  ]);
  const committedTransition = sourceSection(
    uploadSource,
    "  useEffect(() => {\n    if (\n      !reviewTransition ||",
    "  useEffect(() => {\n    if (batchItems.length === 0",
  );
  assertOrdered(committedTransition, [
    "requestAnimationFrame(() => {",
    "router.push(`/review/${reviewTransition.screenshotId}`);",
    'logEvent("transition_done", reviewTransition.detail);',
  ]);
  const frameCallback = sourceSection(
    committedTransition,
    "requestAnimationFrame(() => {",
    "\n    });",
  );
  assert.match(
    frameCallback,
    /router\.push\(`\/review\/\$\{reviewTransition\.screenshotId\}`\);/u,
  );
  assert.match(
    frameCallback,
    /logEvent\("transition_done", reviewTransition\.detail\);/u,
  );
  const screenshotCompletion = sourceSection(
    uploadSource,
    "      if (combined.failureCount === 0) {",
    "    } catch (error) {",
  );
  assert.match(screenshotCompletion, /openReview\(combined\);/u);
  const textCompletion = sourceSection(
    uploadSource,
    "      seedFromUpload(response, {",
    "    } catch (error) {",
  );
  assert.match(textCompletion, /scheduleReviewPush\(response\.screenshot_id\);/u);
  const reviewEntryPoints = sourceSection(
    uploadSource,
    "  function openReview(result: UploadBatchResult)",
    "  async function submit()",
  );
  assert.equal(
    reviewEntryPoints.match(/scheduleReviewPush\(/gu)?.length ?? 0,
    2,
  );
  assert.equal(
    uploadSource.match(/router\.push\(`\/review\/\$\{[^}]+\}`\);/gu)?.length ?? 0,
    1,
  );
});
