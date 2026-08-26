# M1 返工：把 better-sqlite3 换成内置 node:sqlite

## 背景（不是你的错，是施工图的错）
owner 验收 M1 时发现 `npm test` 在本机 **9/17 失败**，全部集中在碰 DB 的用例，报错是原生模块 ABI 不匹配（`NODE_MODULE_VERSION 127` vs 需要 `147`）。根因链已查实：

- 本机与部署目标 mini **都只有 Node 26.7.0（ABI 147）**，不存在 Node 22；施工图原写"Node 22 + better-sqlite3"是 owner 的选型错误。
- better-sqlite3 11.10.0 装出来的二进制是 Node 22 ABI，在 Node 26 下加载即报错。
- 补救三条路全堵：npm 11 默认拦截 install script（`prebuild-install` 不执行）；`--build-from-source` 因本机 Command Line Tools 过旧、node-gyp 失败；无 nvm 可切 Node 22。
- 结论：**这个环境里原生模块这条路不通**，不是代码问题。

owner 已实测 Node 26 内置的 `node:sqlite`（`DatabaseSync`）**无需任何 flag** 即可用，且覆盖本项目全部用法：`prepare/run/get/all/exec/close/lastInsertRowid` 全部正常，`BEGIN`/`COMMIT` 事务实测通过。施工图 PLAN §0 已同步修订。

## Goal（本批只做这一件事，别顺手改别的）
把 `server/src/db.ts` 从 `better-sqlite3` 迁到内置 `node:sqlite`，让 `npm test` 在本机全绿。

具体改动点（owner 已定位，共三处差异）：
1. `import Database from "better-sqlite3"` → `import { DatabaseSync } from "node:sqlite"`；类型 `Database.Database` → `DatabaseSync`。
2. `this.db.pragma("foreign_keys = ON")` → `this.db.exec("PRAGMA foreign_keys = ON")`。
3. **两处 `this.db.transaction(() => {...})`**（db.ts:75、db.ts:189）→ 手写事务包装：`exec('BEGIN')` → 执行 → `exec('COMMIT')`，catch 里 `exec('ROLLBACK')` 后重新抛出。建议抽一个私有方法 `withTransaction<T>(fn: () => T): T` 复用，别在两处各写一遍。
4. `getNativeDatabase()` 的返回类型跟着改。
5. `package.json`：移除 `better-sqlite3` 依赖（连 `@types` 若有一并移除），`engines.node` 从 `22.x` 改 `>=26`。
6. 若测试里有 better-sqlite3 的类型引用，一并跟着改；**测试断言本身不要改**——它们是验收标准，改了就失去意义。

## Scope
只碰 `server/src/db.ts`、`server/package.json`、以及测试文件里为编译通过所必需的类型引用。**不改任何测试断言、不改 agent/llm/app 逻辑、不动 fixtures**。

## Constraints
- 行为必须与原来完全等价（含事务的回滚语义、外键约束开启）。
- `node:sqlite` 的 `run()` 返回 `{ changes, lastInsertRowid }`，字段名与 better-sqlite3 一致，但 `lastInsertRowid` 可能是 bigint——如有数值比较处注意转换，别让类型静默出错。
- 有意简化处照旧 `// simplified:` 标注。
- 中文 commit message，自验全绿才 commit。

## Done when（逐条跑，贴真实输出）
1. `cd server && npm test` —— **17 个用例全过，0 失败**（贴出 `# pass` / `# fail` 那两行）；
2. `npx tsc --noEmit` 零报错；
3. `grep -rn "better-sqlite3" server/ --include="*.ts" --include="*.json" | grep -v node_modules` —— **输出为空**（确认引用清干净）；
4. `node --import tsx src/cli.ts extract ../fixtures/screenshot-1.png` 仍给出清晰的缺-key 报错；
5. `git log --oneline -1` 有本批 commit。

另外回答一个问题（owner 需要知道，如实说即可，不追责）：**你上一批提交时，第 1 条 `npm test` 是真跑过并且全绿吗？** 如果当时也是红的、或者没跑，直接说——这关系到后面几批要不要改验收方式，比面子重要。
