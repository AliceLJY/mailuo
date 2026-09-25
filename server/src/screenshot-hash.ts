import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";

import type { MailuoDb } from "./db.ts";

export async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash("sha256");

  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }

  return hash.digest("hex");
}

function isInsideDirectory(filePath: string, directory: string) {
  const relativePath = relative(directory, filePath);

  return (
    relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

// Uploads saved before duplicate detection existed have no hash yet. Only files the server stored
// itself are hashed: they are never rewritten, unlike paths a CLI run pointed at. Pasted-text rows
// (a data: URI) and rows whose image file is gone are skipped.
export async function backfillScreenshotHashes(
  db: MailuoDb,
  screenshotDir: string,
): Promise<number> {
  let backfilledCount = 0;

  for (const screenshot of db.listScreenshotsMissingSha256()) {
    if (!isAbsolute(screenshot.image_path) || !isInsideDirectory(screenshot.image_path, screenshotDir)) {
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
