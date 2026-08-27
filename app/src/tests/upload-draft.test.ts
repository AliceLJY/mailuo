import assert from "node:assert/strict";
import test from "node:test";

import { initialUploadDraft, uploadDraftReducer } from "../upload-draft";

test("successful upload reset clears the selected image and note", () => {
  const selected = uploadDraftReducer(initialUploadDraft, {
    type: "select-asset",
    asset: {
      uri: "file:///chat.png",
      fileName: "chat.png",
      mimeType: "image/png",
    },
  });
  const withNote = uploadDraftReducer(selected, {
    type: "set-note",
    note: "重点看会议时间",
  });

  assert.deepEqual(uploadDraftReducer(withNote, { type: "reset" }), {
    asset: null,
    note: "",
  });
});
