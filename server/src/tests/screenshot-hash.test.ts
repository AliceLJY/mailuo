import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPastedTextSourceUri } from '../../../shared/core/agent/perceive-text.ts';
import { MailuoDb } from '../db.ts';
import { backfillScreenshotHashes, hashFileSha256 } from '../screenshot-hash.ts';

const emptyExtraction = { participants: [], events: [], facts: [], quotes: [] };

function sha256Hex(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('hashFileSha256 hashes the stored file bytes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mailuo-hash-'));

  try {
    const bytes = Buffer.from('mailuo synthetic screenshot bytes');
    const filePath = join(directory, 'upload.png');
    writeFileSync(filePath, bytes);

    assert.equal(await hashFileSha256(filePath), sha256Hex(bytes));
    await assert.rejects(() => hashFileSha256(join(directory, 'missing.png')), { code: 'ENOENT' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('backfillScreenshotHashes covers finished uploads whose file still exists and runs only once per row', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mailuo-backfill-'));
  const screenshotDir = join(directory, 'screenshots');
  mkdirSync(screenshotDir);
  const db = new MailuoDb(join(directory, 'mailuo.sqlite'));

  try {
    const bytes = Buffer.from('mailuo synthetic screenshot bytes');
    const earlierPath = join(screenshotDir, 'earlier.png');
    const laterPath = join(screenshotDir, 'later.png');
    // A CLI run can point a row at any file; such a file may be rewritten later, so it is skipped.
    const outsidePath = join(directory, 'outside.png');
    writeFileSync(earlierPath, bytes);
    writeFileSync(laterPath, bytes);
    writeFileSync(outsidePath, bytes);

    function saveFinishedUpload(imagePath: string) {
      const screenshot = db.createScreenshot({ imagePath });
      db.saveScreenshotAnalysis({
        screenshotId: screenshot.id,
        rawExtraction: emptyExtraction,
        cards: [],
      });
      return screenshot;
    }

    // Before duplicate detection existed, the same file could be uploaded and processed twice.
    const earlier = saveFinishedUpload(earlierPath);
    const later = saveFinishedUpload(laterPath);
    saveFinishedUpload(join(screenshotDir, 'deleted.png'));
    saveFinishedUpload(createPastedTextSourceUri('示例粘贴文本'));
    saveFinishedUpload(outsidePath);
    db.createScreenshot({ imagePath: earlierPath });

    assert.equal(await backfillScreenshotHashes(db, screenshotDir), 2);
    assert.deepEqual(
      db
        .getNativeDatabase()
        .prepare('SELECT screenshot_id, sha256 FROM server_screenshot_hashes ORDER BY screenshot_id')
        .all(),
      [
        { screenshot_id: earlier.id, sha256: sha256Hex(bytes) },
        { screenshot_id: later.id, sha256: sha256Hex(bytes) },
      ],
    );
    assert.equal(db.findScreenshotIdBySha256(sha256Hex(bytes)), later.id);
    assert.equal(await backfillScreenshotHashes(db, screenshotDir), 0);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
