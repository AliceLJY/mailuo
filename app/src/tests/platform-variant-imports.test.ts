import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sourceRoots = [join(repoRoot, "app/src"), join(repoRoot, "shared")];
const platformVariantPattern = /^(?<stem>.+)\.(?:native|android|ios)\.tsx?$/u;

function listTypeScriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(directory, entry.name);

    if (entry.isDirectory()) {
      return listTypeScriptFiles(entryPath);
    }

    return entry.isFile() && /\.tsx?$/u.test(entry.name) ? [entryPath] : [];
  });
}

function importDeclarationRunsAtRuntime(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;

  if (!clause) {
    return true;
  }

  if (clause.isTypeOnly) {
    return false;
  }

  if (clause.name) {
    return true;
  }

  const bindings = clause.namedBindings;

  if (!bindings) {
    return false;
  }

  return ts.isNamespaceImport(bindings) || bindings.elements.some((item) => !item.isTypeOnly);
}

function exportDeclarationRunsAtRuntime(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) {
    return false;
  }

  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) {
    return true;
  }

  return node.exportClause.elements.some((item) => !item.isTypeOnly);
}

function hasRuntimeImport(filePath: string, bareSpecifier: string): boolean {
  const source = ts.createSourceFile(
    filePath,
    readFileSync(filePath, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let found = false;

  function visit(node: ts.Node): void {
    if (found) {
      return;
    }

    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === bareSpecifier &&
      importDeclarationRunsAtRuntime(node)
    ) {
      found = true;
      return;
    }

    if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === bareSpecifier &&
      exportDeclarationRunsAtRuntime(node)
    ) {
      found = true;
      return;
    }

    if (
      ts.isCallExpression(node) &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === bareSpecifier &&
      (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")
      )
    ) {
      found = true;
      return;
    }

    ts.forEachChild(node, visit);
  }

  visit(source);
  return found;
}

function findAmbiguousPlatformImports(): string[] {
  return sourceRoots.flatMap(listTypeScriptFiles).flatMap((variantPath) => {
    const match = platformVariantPattern.exec(basename(variantPath));
    const stem = match?.groups?.stem;

    if (!stem) {
      return [];
    }

    const hasBareSibling = ["ts", "tsx"].some((extension) =>
      existsSync(join(dirname(variantPath), `${stem}.${extension}`)),
    );

    if (!hasBareSibling || !hasRuntimeImport(variantPath, `./${stem}`)) {
      return [];
    }

    return [`${relative(repoRoot, variantPath)} imports ./${stem}`];
  });
}

test("platform variants never runtime-import an ambiguous same-stem bare module", () => {
  const violations = findAmbiguousPlatformImports();

  assert.deepEqual(
    violations,
    [],
    `Platform variant self-imports are ambiguous under Metro:\n${violations.join("\n")}`,
  );
});
