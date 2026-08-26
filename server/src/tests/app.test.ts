import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { MailuoDb } from '../db.ts';
import { buildApp } from '../app.ts';
import { ConfigurationError } from '../llm/provider.ts';

function withTempAppDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'mailuo-app-'));
  const databasePath = join(directory, 'mailuo.sqlite');
  const screenshotDir = join(directory, 'screenshots');
  const db = new MailuoDb(databasePath);

  return {
    db,
    screenshotDir,
    cleanup() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function buildMultipartBody(
  parts: Array<
    | { type: 'field'; name: string; value: string }
    | {
        type: 'file';
        name: string;
        filename?: string;
        contentType: string;
        value: Buffer;
      }
  >,
) {
  const boundary = '----mailuo-test-boundary';
  const chunks: Buffer[] = [];

  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`, 'utf8'));

    if (part.type === 'field') {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`,
          'utf8',
        ),
      );
      continue;
    }

    chunks.push(
      Buffer.from(
        [
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename ?? 'upload'}"`,
          `Content-Type: ${part.contentType}`,
          '',
        ].join('\r\n'),
        'utf8',
      ),
    );
    chunks.push(Buffer.from('\r\n', 'utf8'));
    chunks.push(part.value);
    chunks.push(Buffer.from('\r\n', 'utf8'));
  }

  chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  return {
    boundary,
    body: Buffer.concat(chunks),
  };
}

async function withScreenshotDir<T>(
  screenshotDir: string,
  callback: () => Promise<T>,
): Promise<T> {
  const previousValue = process.env.SCREENSHOT_DIR;
  process.env.SCREENSHOT_DIR = screenshotDir;

  try {
    return await callback();
  } finally {
    if (previousValue === undefined) {
      delete process.env.SCREENSHOT_DIR;
    } else {
      process.env.SCREENSHOT_DIR = previousValue;
    }
  }
}

const fakeImage = readFileSync(new URL('../../../fixtures/screenshot-1.png', import.meta.url));

test('POST /api/screenshots accepts note after image and stores a MIME-derived extension', async () => {
  const { db, screenshotDir, cleanup } = withTempAppDirectory();
  let receivedNote: string | undefined;
  let receivedMimeType: string | undefined;

  const app = buildApp({
    db,
    async perceiveScreenshot(input) {
      receivedNote = input.note;
      receivedMimeType = input.imageMimeType;
      return { participants: [], events: [], facts: [], quotes: [] };
    },
    proposeCards() {
      return [];
    },
  });

  try {
    const { boundary, body } = buildMultipartBody([
      {
        type: 'file',
        name: 'image',
        contentType: 'image/png',
        value: fakeImage,
      },
      {
        type: 'field',
        name: 'note',
        value: '补充说明在图片后面',
      },
    ]);

    const response = await withScreenshotDir(screenshotDir, () =>
      app.inject({
        method: 'POST',
        url: '/api/screenshots',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      }),
    );

    assert.equal(response.statusCode, 201);
    assert.equal(receivedNote, '补充说明在图片后面');
    assert.equal(receivedMimeType, 'image/png');

    const payload = response.json();
    const screenshot = db.getScreenshotById(payload.data.screenshot_id);
    assert.ok(screenshot);
    assert.match(screenshot.image_path, /\.png$/);
  } finally {
    await app.close();
    cleanup();
  }
});

test('buildApp closes app-owned databases and leaves injected databases open', async () => {
  const ownedDirectory = mkdtempSync(join(tmpdir(), 'mailuo-owned-app-'));
  const injectedDirectory = mkdtempSync(join(tmpdir(), 'mailuo-injected-app-'));

  class TrackingDb extends MailuoDb {
    wasClosed = false;

    override close() {
      this.wasClosed = true;
      super.close();
    }
  }

  let ownedDb: TrackingDb | undefined;
  const ownedApp = buildApp({
    createDb: () => {
      ownedDb = new TrackingDb(join(ownedDirectory, 'owned.sqlite'));
      return ownedDb;
    },
  });

  const injectedDb = new TrackingDb(join(injectedDirectory, 'injected.sqlite'));
  const injectedApp = buildApp({ db: injectedDb });

  try {
    await ownedApp.close();
    assert.equal(ownedDb?.wasClosed, true);

    await injectedApp.close();
    assert.equal(injectedDb.wasClosed, false);
  } finally {
    if (injectedApp.server.listening) {
      await injectedApp.close();
    }

    if (!injectedDb.wasClosed) {
      injectedDb.close();
    }

    rmSync(ownedDirectory, { recursive: true, force: true });
    rmSync(injectedDirectory, { recursive: true, force: true });
  }
});

test('POST /api/screenshots rejects multiple image parts', async () => {
  const { db, screenshotDir, cleanup } = withTempAppDirectory();
  const app = buildApp({
    db,
    async perceiveScreenshot() {
      return { participants: [], events: [], facts: [], quotes: [] };
    },
    proposeCards() {
      return [];
    },
  });

  try {
    const { boundary, body } = buildMultipartBody([
      {
        type: 'file',
        name: 'image',
        contentType: 'image/png',
        value: fakeImage,
      },
      {
        type: 'file',
        name: 'image',
        contentType: 'image/png',
        value: fakeImage,
      },
    ]);

    const response = await withScreenshotDir(screenshotDir, () =>
      app.inject({
        method: 'POST',
        url: '/api/screenshots',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      }),
    );

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), {
      ok: false,
      error: {
        message: 'Only one image upload is supported',
        code: 'TOO_MANY_IMAGES',
      },
    });
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /api/screenshots rejects unexpected file parts', async () => {
  const { db, screenshotDir, cleanup } = withTempAppDirectory();
  const app = buildApp({
    db,
    async perceiveScreenshot() {
      return { participants: [], events: [], facts: [], quotes: [] };
    },
    proposeCards() {
      return [];
    },
  });

  try {
    const { boundary, body } = buildMultipartBody([
      {
        type: 'file',
        name: 'avatar',
        contentType: 'image/png',
        value: fakeImage,
      },
    ]);

    const response = await withScreenshotDir(screenshotDir, () =>
      app.inject({
        method: 'POST',
        url: '/api/screenshots',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      }),
    );

    assert.equal(response.statusCode, 400);
    assert.deepEqual(response.json(), {
      ok: false,
      error: {
        message: 'Unexpected file field "avatar"',
        code: 'UNEXPECTED_FILE_FIELD',
      },
    });
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /api/screenshots returns clear operational errors without stack details and cleans partial uploads', async () => {
  const { db, screenshotDir, cleanup } = withTempAppDirectory();
  const preservedScreenshot = db.createScreenshot({
    imagePath: '/tmp/preserved-shot.png',
    userNote: null,
    uploadedAt: '2026-08-26T00:00:00.000Z',
  });
  const app = buildApp({
    db,
    async perceiveScreenshot() {
      throw new ConfigurationError(
        'Missing required environment variable DASHSCOPE_API_KEY',
        'DASHSCOPE_API_KEY',
      );
    },
    proposeCards() {
      return [];
    },
  });

  try {
    const { boundary, body } = buildMultipartBody([
      {
        type: 'file',
        name: 'image',
        contentType: 'image/png',
        value: fakeImage,
      },
    ]);

    const response = await withScreenshotDir(screenshotDir, () =>
      app.inject({
        method: 'POST',
        url: '/api/screenshots',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      }),
    );

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), {
      ok: false,
      error: {
        message: 'Missing required environment variable DASHSCOPE_API_KEY',
        code: 'CONFIG_ERROR',
      },
    });
    assert.deepEqual(readdirSync(screenshotDir), []);
    assert.equal(db.getScreenshotById(preservedScreenshot.id)?.image_path, '/tmp/preserved-shot.png');
    const screenshotRows = db
      .getNativeDatabase()
      .prepare('SELECT id FROM screenshots ORDER BY id')
      .all() as Array<{ id: number }>;
    assert.deepEqual(screenshotRows, [{ id: preservedScreenshot.id }]);
  } finally {
    await app.close();
    cleanup();
  }
});

test('POST /api/screenshots cleans partial uploads when screenshot analysis persistence fails', async () => {
  const { db, screenshotDir, cleanup } = withTempAppDirectory();
  const originalSaveScreenshotAnalysis = db.saveScreenshotAnalysis.bind(db);

  db.saveScreenshotAnalysis = () => {
    throw new Error('card persistence failed');
  };

  const app = buildApp({
    db,
    async perceiveScreenshot() {
      return {
        participants: [],
        events: [],
        facts: [],
        quotes: [],
      };
    },
    proposeCards() {
      return [];
    },
  });

  try {
    const { boundary, body } = buildMultipartBody([
      {
        type: 'file',
        name: 'image',
        contentType: 'image/png',
        value: fakeImage,
      },
    ]);

    const response = await withScreenshotDir(screenshotDir, () =>
      app.inject({
        method: 'POST',
        url: '/api/screenshots',
        headers: {
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload: body,
      }),
    );

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), {
      ok: false,
      error: {
        message: 'Unexpected server error',
        code: 'INTERNAL_ERROR',
      },
    });
    assert.deepEqual(readdirSync(screenshotDir), []);
    const screenshotRows = db
      .getNativeDatabase()
      .prepare('SELECT id FROM screenshots ORDER BY id')
      .all() as Array<{ id: number }>;
    assert.deepEqual(screenshotRows, []);
  } finally {
    db.saveScreenshotAnalysis = originalSaveScreenshotAnalysis;
    await app.close();
    cleanup();
  }
});
