import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";

import type { MailuoDb } from "./db.ts";

export async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

// Uploads saved before duplicate detection existed have no hash yet. Uploads are stored under an
// absolute path; pasted-text rows (a data: URI) and rows whose image file is gone are skipped.
export async function backfillScreenshotHashes(db: MailuoDb): Promise<number> {
  let backfilledCount = 0;

  for (const screenshot of db.listScreenshotsMissingSha256()) {
    if (!isAbsolute(screenshot.image_path)) {
      continue;
    }

    let sha256: string;
    try {
      sha256 = await hashFileSha256(screenshot.image_path);
    } catch {
      continue;
    }

    db.recordScreenshotSha256(screenshot.id, sha256);
    backfilledCount += 1;
  }

  return backfilledCount;
}
