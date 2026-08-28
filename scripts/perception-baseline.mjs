#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const SERVER_DIR = resolve(REPO_ROOT, "server");
const SERVER_ENV = resolve(SERVER_DIR, ".env");
const SNAPSHOT_DIR = resolve(REPO_ROOT, "docs", "perception-baseline");
const BASELINE_NOW = "2026-08-29T08:00:00+08:00";
const FIXTURES = [1, 2, 3].map((index) =>
  resolve(REPO_ROOT, "fixtures", "screenshot-" + index + ".png"),
);

const WORKER_SOURCE = [
  "import { basename } from 'node:path';",
  "import { perceiveScreenshot } from './src/agent/perceive.ts';",
  "import { createQwenProvider } from './src/llm/qwen.ts';",
  "const [nowIso, ...imagePaths] = process.argv.slice(1);",
  "if (!process.env.DASHSCOPE_API_KEY?.trim()) {",
  "  throw new Error('缺少 DASHSCOPE_API_KEY；请配置 server/.env 或当前环境变量。');",
  "}",
  "const provider = createQwenProvider();",
  "const results = [];",
  "for (const imagePath of imagePaths) {",
  "  console.error('Qwen-VL 正在处理 ' + basename(imagePath) + '…');",
  "  const extraction = await perceiveScreenshot({",
  "    imagePath,",
  "    provider,",
  "    now: new Date(nowIso),",
  "  });",
  "  results.push({ fixture: basename(imagePath), extraction });",
  "}",
  "process.stdout.write(JSON.stringify({ model: provider.model, results }));",
].join("\n");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function fileHash(path, algorithm) {
  return createHash(algorithm).update(await readFile(path)).digest("hex");
}

async function runVisualPerception() {
  const nodeArgs = [];
  const childEnv = { ...process.env };

  if (!childEnv.DASHSCOPE_API_KEY?.trim()) {
    delete childEnv.DASHSCOPE_API_KEY;
  }

  if (await exists(SERVER_ENV)) {
    nodeArgs.push("--env-file=.env");
  } else if (!process.env.DASHSCOPE_API_KEY?.trim()) {
    throw new Error(
      "缺少 DASHSCOPE_API_KEY；请配置 server/.env 或当前环境变量，视觉基线未执行。",
    );
  }

  nodeArgs.push(
    "--import",
    "tsx",
    "--input-type=module",
    "--eval",
    WORKER_SOURCE,
    "--",
    BASELINE_NOW,
    ...FIXTURES,
  );

  return await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd: SERVER_DIR,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || "Qwen-VL 基线子进程失败，退出码 " + code));
        return;
      }

      try {
        resolveResult(JSON.parse(stdout));
      } catch (error) {
        reject(
          new Error(
            "Qwen-VL 基线输出不是合法 JSON：" +
              (error instanceof Error ? error.message : String(error)),
          ),
        );
      }
    });
  });
}

function snapshotName(fixtureName) {
  return fixtureName.replace(/\.png$/u, ".qwen-vl.json");
}

function canonicalJson(value) {
  return JSON.stringify(value, null, 2) + "\n";
}

async function readCanonicalJson(path, label) {
  const content = await readFile(path, "utf8");
  let value;

  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(
      label + " 不是合法 JSON：" +
        (error instanceof Error ? error.message : String(error)),
    );
  }

  if (canonicalJson(value) !== content) {
    throw new Error(label + " 不是脚本生成的规范 JSON，文件未修改。");
  }

  return { content, value };
}

async function main() {
  const snapshotNames = FIXTURES.map((fixture) => snapshotName(basename(fixture)));
  const expectedFiles = [
    resolve(SNAPSHOT_DIR, "manifest.json"),
    ...snapshotNames.map((name) => resolve(SNAPSHOT_DIR, name)),
  ];
  const present = await Promise.all(expectedFiles.map((path) => exists(path)));
  const hasAny = present.some(Boolean);
  const hasAll = present.every(Boolean);

  if (hasAny && !hasAll) {
    throw new Error(
      "视觉基线目录只存在部分文件；请先恢复完整快照，脚本不会调用 API 或覆盖不完整基线。",
    );
  }

  const creating = !hasAll;
  const fixtureHashes = await Promise.all(FIXTURES.map(async (fixture) => ({
    md5: await fileHash(fixture, "md5"),
    sha256: await fileHash(fixture, "sha256"),
  })));

  if (!creating) {
    const manifestPath = resolve(SNAPSHOT_DIR, "manifest.json");
    const manifestFile = await readCanonicalJson(manifestPath, "manifest.json");
    const manifest = manifestFile.value;

    if (typeof manifest?.model !== "string" || !manifest.model.trim()) {
      throw new Error("manifest.json 缺少有效的模型名。");
    }

    const expectedManifest = canonicalJson({
      formatVersion: 1,
      baselineNow: BASELINE_NOW,
      provider: "Qwen",
      model: manifest.model,
      fixtures: FIXTURES.map((fixture, index) => ({
        fixture: basename(fixture),
        fixtureMd5: fixtureHashes[index].md5,
        fixtureSha256: fixtureHashes[index].sha256,
        snapshot: snapshotNames[index],
      })),
    });

    if (manifestFile.content !== expectedManifest) {
      throw new Error("fixture 哈希或 manifest 元数据与已保存基线不一致，文件未修改。");
    }

    process.stdout.write("视觉基线模式：已有快照离线校验（不调用 API）\n");
    process.stdout.write("模型：" + manifest.model + "\n");
    process.stdout.write("固定时间锚点：" + BASELINE_NOW + "\n\n");

    for (const [index, snapshotNameValue] of snapshotNames.entries()) {
      const snapshot = await readCanonicalJson(
        resolve(SNAPSHOT_DIR, snapshotNameValue),
        snapshotNameValue,
      );
      process.stdout.write("=== " + basename(FIXTURES[index]) + " ===\n");
      process.stdout.write(snapshot.content);
      process.stdout.write("快照：" + snapshotNameValue + "（JSON 与素材哈希校验通过）\n\n");
    }

    process.stdout.write("manifest.json（元数据与三张 fixture 哈希校验通过）\n");
    process.stdout.write("现有基线保持不变；本次没有调用 Qwen-VL。\n");
    return;
  }

  const run = await runVisualPerception();
  const expectedFixtureNames = FIXTURES.map((fixture) => basename(fixture));
  const actualFixtureNames = run.results?.map(({ fixture }) => fixture);

  if (
    !Array.isArray(actualFixtureNames) ||
    actualFixtureNames.length !== expectedFixtureNames.length ||
    actualFixtureNames.some((fixture, index) => fixture !== expectedFixtureNames[index])
  ) {
    throw new Error("Qwen-VL 基线返回的 fixture 数量或顺序不符合预期，快照未写入。");
  }

  const snapshots = run.results.map(({ fixture, extraction }) => ({
    fixture,
    extraction,
    name: snapshotName(fixture),
    content: canonicalJson(extraction),
  }));
  const manifest = canonicalJson({
    formatVersion: 1,
    baselineNow: BASELINE_NOW,
    provider: "Qwen",
    model: run.model,
    fixtures: snapshots.map((snapshot, index) => ({
      fixture: snapshot.fixture,
      fixtureMd5: fixtureHashes[index].md5,
      fixtureSha256: fixtureHashes[index].sha256,
      snapshot: snapshot.name,
    })),
  });
  process.stdout.write("视觉基线模式：首次创建\n");
  process.stdout.write("模型：" + run.model + "\n");
  process.stdout.write("固定时间锚点：" + BASELINE_NOW + "\n\n");

  for (const snapshot of snapshots) {
    process.stdout.write("=== " + snapshot.fixture + " ===\n");
    process.stdout.write(snapshot.content);
    process.stdout.write("快照：" + snapshot.name + "（已创建）\n\n");
  }

  await mkdir(SNAPSHOT_DIR, { recursive: true });
  await Promise.all([
    writeFile(resolve(SNAPSHOT_DIR, "manifest.json"), manifest, {
      encoding: "utf8",
      flag: "wx",
    }),
    ...snapshots.map((snapshot) =>
      writeFile(resolve(SNAPSHOT_DIR, snapshot.name), snapshot.content, {
        encoding: "utf8",
        flag: "wx",
      }),
    ),
  ]);
  process.stdout.write("基线目录：" + SNAPSHOT_DIR + "\n");
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write("视觉基线失败：" + message + "\n");
  process.exitCode = 1;
});
