import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const coreRoot = new URL('../../../shared/core/', import.meta.url);
const forbiddenImport = /(?:from\s+|import\s*\(\s*|import\s+)['"](?:node:|fs(?:\/|['"])|path(?:\/|['"]))/u;

function listTypeScriptFiles(directory: URL): URL[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryUrl = new URL(entry.isDirectory() ? `${entry.name}/` : entry.name, directory);

    if (entry.isDirectory()) {
      return listTypeScriptFiles(entryUrl);
    }

    return entry.isFile() && entry.name.endsWith('.ts') ? [entryUrl] : [];
  });
}

test('shared core does not import Node-only filesystem or path modules', () => {
  const violations = listTypeScriptFiles(coreRoot).flatMap((fileUrl) =>
    readFileSync(fileUrl, 'utf8')
      .split('\n')
      .map((line, index) => ({ file: fileUrl.pathname, line: index + 1, source: line.trim() }))
      .filter((entry) => forbiddenImport.test(entry.source)),
  );

  assert.deepEqual(violations, []);
});
