import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, relative, dirname, sep } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dirname, "..");
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    return entry.isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
  });
}
function layer(path: string): string {
  const local = relative(root, path).split(sep).join("/");
  if (local.startsWith("plugins/dsh-mindsea/src/")) return "dsh";
  if (local === "src/main.ts") return "main";
  return local.split("/")[1]!;
}
const allowed: Record<string, string[]> = {
  contracts: ["contracts"],
  client: ["client", "contracts"],
  application: ["application", "contracts", "client"],
  storage: ["storage", "contracts"],
  search: ["search", "storage", "contracts"],
  http: ["http", "application", "storage", "search", "contracts"],
  dsh: ["dsh", "client", "application", "contracts"],
  main: ["contracts", "application", "storage", "search", "http", "client"],
};

test("production imports respect architecture boundaries and cannot pull server internals into DSH", () => {
  const violations: string[] = [];
  for (const path of [
    ...files(resolve(root, "src")),
    ...files(resolve(root, "plugins/dsh-mindsea/src")),
  ]) {
    const owner = layer(path);
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const check = (specifier: string) => {
      const target = specifier.startsWith(".")
        ? layer(resolve(dirname(path), specifier))
        : undefined;
      if (target && !allowed[owner]?.includes(target))
        violations.push(`${relative(root, path)} -> ${specifier}`);
      if (owner === "contracts" && specifier.startsWith("node:"))
        violations.push(`contracts imports runtime ${specifier}`);
      if (owner === "dsh" && specifier === "node:sqlite")
        violations.push("DSH imports SQLite");
      if (owner !== "dsh" && specifier.startsWith("@deepseek-ai/"))
        violations.push(`service depends on DSH: ${relative(root, path)}`);
    };
    const visit = (node: ts.Node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      )
        check(node.moduleSpecifier.text);
      if (
        ts.isImportTypeNode(node) &&
        ts.isLiteralTypeNode(node.argument) &&
        ts.isStringLiteral(node.argument.literal)
      )
        check(node.argument.literal.text);
      if (
        ts.isCallExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        node.arguments[0] &&
        ts.isStringLiteral(node.arguments[0])
      )
        check(node.arguments[0].text);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  assert.deepEqual(violations, []);
});
