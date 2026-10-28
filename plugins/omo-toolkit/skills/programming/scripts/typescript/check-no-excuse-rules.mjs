#!/usr/bin/env bun
// Modified-port notice: OMP adaptation of oh-my-openagent 8a8db1d3094da8743989bf693ee5de77889de50e; SUL-1.0 (see plugin LICENSE-SUL-1.0).
// Optional syntax-policy checker. Resolves the stable TypeScript >=5.8 compiler API from caller cwd; never installs packages.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";

function loadTypescriptFromCaller() {
  const callerRequire = createRequire(path.join(process.cwd(), "no-excuse-anchor.cjs"));
  try {
    const compiler = callerRequire("typescript"),
      [major = 0, minor = 0] = compiler.versionMajorMinor.split(".").map(Number);
    if ((major > 5 || (major === 5 && minor >= 8)) && typeof compiler.createSourceFile === "function") return compiler;
  } catch {}
  console.error(
    `error: caller project (${process.cwd()}) requires an installed TypeScript >=5.8 stable compiler API; no packages were installed.`,
  );
  process.exit(2);
}
const ts = loadTypescriptFromCaller(),
  INCLUDED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]),
  IGNORED_DIRECTORIES = new Set([".git", ".next", ".nuxt", ".turbo", ".yarn", "coverage", "dist", "build", "node_modules"]),
  OPT_OUT_RE = /\/\/\s*no-excuse-ok:\s*any/,
  CATCH_OK_RE = /\/\/\s*no-excuse-ok:\s*catch/;
function isIncludedFile(filePath) {
  return INCLUDED_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
function isDeclarationFile(filePath) {
  return filePath.endsWith(".d.ts") || filePath.endsWith(".d.mts") || filePath.endsWith(".d.cts");
}
function discoverFiles(inputs) {
  const files = [];
  for (const input of inputs) {
    const resolved = path.resolve(input);
    if (!fs.existsSync(resolved)) {
      console.error(`Path does not exist: ${resolved}`);
      process.exit(2);
    }
    if (fs.statSync(resolved).isFile()) {
      if (isIncludedFile(resolved) && !isDeclarationFile(resolved)) files.push(resolved);
      continue;
    }
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: !0 }))
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) walk(path.join(dir, entry.name));
        } else if (isIncludedFile(entry.name) && !isDeclarationFile(entry.name)) files.push(path.join(dir, entry.name));
    };
    walk(resolved);
  }
  return files;
}
function getLineText(sourceFile, line) {
  const lineStarts = sourceFile.getLineStarts(),
    start = lineStarts[line],
    end = line + 1 < lineStarts.length ? lineStarts[line + 1] : sourceFile.getEnd();
  return sourceFile.text.slice(start, end);
}
function parseSourceFiles(filePaths) {
  return new Map(
    filePaths.map((filePath) => [filePath, ts.createSourceFile(filePath, fs.readFileSync(filePath, "utf-8"), ts.ScriptTarget.Latest, !0)]),
  );
}
function analyzeFile(filePath, sourceFile) {
  const source = fs.readFileSync(filePath, "utf-8"),
    violations = [];
  function pos(node) {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return { line: line + 1, column: character + 1 };
  }
  function lineHasOptOut(node) {
    const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    return OPT_OUT_RE.test(getLineText(sourceFile, line));
  }
  function visit(node) {
    if (ts.isAsExpression(node)) {
      const typeText = node.type.getText(sourceFile);
      if (typeText === "any") {
        const p = pos(node);
        violations.push({ ruleId: "no-any-assertion", filePath, ...p, message: "`as any`: narrow with type guards or redesign the types" });
      }
      if (typeText === "unknown") {
        const p = pos(node);
        violations.push({ ruleId: "no-unknown-assertion", filePath, ...p, message: "`as unknown`: redesign the types" });
      }
    }
    if (ts.isEnumDeclaration(node)) {
      const p = pos(node);
      violations.push({ ruleId: "no-enum", filePath, ...p, message: "`enum`: use `as const` object + literal union type" });
    }
    if (ts.isNonNullExpression(node)) {
      const p = pos(node);
      violations.push({ ruleId: "no-non-null-assertion", filePath, ...p, message: "`x!`: use narrowing or optional chaining" });
    }
    if (ts.isThrowStatement(node) && node.expression) {
      const expr = node.expression;
      if (ts.isStringLiteral(expr) || ts.isNumericLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
        const p = pos(node);
        violations.push({ ruleId: "no-throw-literal", filePath, ...p, message: "`throw literal`: throw an Error subclass" });
      }
      if (ts.isTemplateExpression(expr)) {
        const p = pos(node);
        violations.push({ ruleId: "no-throw-literal", filePath, ...p, message: "`throw template`: throw an Error subclass" });
      }
    }
    if (ts.isVariableStatement(node)) {
      if (node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
        if (!(node.declarationList.flags & ts.NodeFlags.Const)) {
          const p = pos(node);
          violations.push({ ruleId: "no-mutable-export", filePath, ...p, message: "`export let/var`: use `export const`" });
        }
      }
    }
    if (ts.isTypeReferenceNode(node) || node.kind === ts.SyntaxKind.AnyKeyword) {
      if (node.kind === ts.SyntaxKind.AnyKeyword && !lineHasOptOut(node)) {
        const parent = node.parent;
        if (parent && ts.isAsExpression(parent));
        else if (
          parent &&
          (ts.isParameter(parent) || ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent))
        ) {
          const p = pos(node);
          violations.push({ ruleId: "no-any-annotation", filePath, ...p, message: "`: any` annotation: use `unknown` and narrow" });
        } else if (
          parent &&
          (ts.isFunctionDeclaration(parent) ||
            ts.isMethodDeclaration(parent) ||
            ts.isArrowFunction(parent) ||
            ts.isFunctionExpression(parent))
        ) {
          const p = pos(node);
          violations.push({ ruleId: "no-explicit-any-return", filePath, ...p, message: "`(): any` return: use a specific type" });
        }
      }
    }
    if (ts.isCatchClause(node)) {
      const catchLine = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line,
        catchLineText = getLineText(sourceFile, catchLine);
      if (!CATCH_OK_RE.test(catchLineText)) {
        const body = node.block;
        if (body.statements.length === 0) {
          const p = pos(node);
          violations.push({
            ruleId: "empty-catch",
            filePath,
            ...p,
            message: "empty `catch` block: handle, re-throw, or remove the try/catch",
          });
        } else if (node.variableDeclaration) {
          const varName = node.variableDeclaration.name.getText(sourceFile),
            blockText = body.getText(sourceFile),
            hasInstanceof = blockText.includes("instanceof"),
            hasRethrow = blockText.includes(`throw ${varName}`) || blockText.includes("throw new");
          if (!hasInstanceof && !hasRethrow) {
            const p = pos(node);
            violations.push({
              ruleId: "catch-without-narrowing",
              filePath,
              ...p,
              message: "`catch` without `instanceof` narrowing or re-throw: narrow the error type or re-throw",
            });
          }
        }
      }
    }
    node.forEachChild(visit);
  }
  visit(sourceFile);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, !1, ts.LanguageVariant.Standard, source);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token !== ts.SyntaxKind.SingleLineCommentTrivia && token !== ts.SyntaxKind.MultiLineCommentTrivia) continue;
    const comment = scanner.getTokenText(),
      directives = /@ts-(ignore|expect-error)\b/g;
    for (const match of comment.matchAll(directives)) {
      const { line, character } = sourceFile.getLineAndCharacterOfPosition(scanner.getTokenPos() + (match.index ?? 0)),
        kind = match[1];
      violations.push({
        ruleId: kind === "ignore" ? "no-ts-ignore" : "no-ts-expect-error",
        filePath,
        line: line + 1,
        column: character + 1,
        message: `\`@ts-${kind}\`: review the suppression against the opted-in policy`,
      });
    }
  }
  return violations;
}
function formatViolation(v) {
  return `${v.filePath}:${v.line}:${v.column}: [${v.ruleId}] ${v.message}`;
}
async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("usage: check-no-excuse-rules.mjs <file-or-dir>...");
    process.exit(2);
  }
  const files = discoverFiles(args);
  if (files.length === 0) {
    console.error("No TypeScript files found.");
    process.exit(2);
  }
  const sourceFiles = parseSourceFiles(files),
    violations = files.flatMap((filePath) => {
      const sourceFile = sourceFiles.get(filePath);
      if (!sourceFile) throw Error(`TypeScript did not parse ${filePath}`);
      return analyzeFile(filePath, sourceFile);
    });
  if (violations.length === 0) {
    console.log(`No violations in ${files.length} file(s).`);
    return;
  }
  for (const v of violations) console.error(formatViolation(v));
  console.error(`
${violations.length} violation(s) in ${files.length} file(s).`);
  process.exit(1);
}
await main();
