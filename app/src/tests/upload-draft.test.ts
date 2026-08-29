import assert from "node:assert/strict";
import test from "node:test";

import type { UploadImageAsset } from "../types";
import {
  initialUploadDraft,
  MAX_UPLOAD_ASSETS,
  uploadDraftReducer,
} from "../upload-draft";

function asset(index: number): UploadImageAsset {
  return {
    uri: `file:///chat-${index}.png`,
    fileName: `chat-${index}.png`,
    mimeType: "image/png",
  };
}

test("upload draft preserves picker order and removes only the selected index", () => {
  const firstSelection = [asset(1), asset(2), asset(3)];
  const selected = uploadDraftReducer(initialUploadDraft, {
    type: "add-assets",
    assets: firstSelection,
  });
  const withNote = uploadDraftReducer(selected, {
    type: "set-note",
    note: "重点看会议时间",
  });
  const appended = uploadDraftReducer(withNote, {
    type: "add-assets",
    assets: [asset(4), asset(5)],
  });
  const removed = uploadDraftReducer(appended, {
    type: "remove-asset",
    index: 1,
  });

  assert.deepEqual(
    removed.assets.map((item) => item.fileName),
    ["chat-1.png", "chat-3.png", "chat-4.png", "chat-5.png"],
  );
  assert.equal(removed.note, "重点看会议时间");
});

test("upload draft keeps the first twenty assets in picker order", () => {
  const first = uploadDraftReducer(initialUploadDraft, {
    type: "add-assets",
    assets: Array.from({ length: 18 }, (_value, index) => asset(index + 1)),
  });
  const capped = uploadDraftReducer(first, {
    type: "add-assets",
    assets: [asset(19), asset(20), asset(21)],
  });

  assert.equal(capped.assets.length, MAX_UPLOAD_ASSETS);
  assert.deepEqual(
    capped.assets.map((item) => item.fileName),
    Array.from({ length: 20 }, (_value, index) => `chat-${index + 1}.png`),
  );
});

test("successful batch reset clears every selected image and the shared note", () => {
  const selected = uploadDraftReducer(initialUploadDraft, {
    type: "add-assets",
    assets: [asset(1), asset(2)],
  });
  const withNote = uploadDraftReducer(selected, {
    type: "set-note",
    note: "重点看会议时间",
  });

  assert.deepEqual(uploadDraftReducer(withNote, { type: "reset" }), {
    assets: [],
    note: "",
  });
});
