// scripts/test-ts-hooks.mjs
// Minimal ESM resolver hook that lets Node execute the project's TypeScript
// DIRECTLY — no build step, no compiled artefacts, no reimplementation.
//
// WHY THIS EXISTS
//
// lib/trade-manager.ts is the production function we must test, but it (and its
// imports) use the `@/*` path alias from tsconfig.json. Path aliases are a
// compile-time construct: Node cannot resolve `@/lib/instruments`, so importing
// the real module fails with TS2307-style resolution errors.
//
// Node 24 strips TypeScript types natively, so the ONLY missing piece is alias
// resolution. This hook supplies exactly that and nothing else. It deliberately
// does not transform code, rewrite semantics, or shadow any module.
//
// Usage (see package.json "test:trade-manager"):
//   node --import ./scripts/test-ts-register.mjs tests/trade-manager-shadow.test.mjs

import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// Mirrors tsconfig.json: "paths": { "@/*": ["./*"] }
const ALIAS_PREFIX = '@/'
// Extension-less specifiers must probe the same extensions the bundler would.
const CANDIDATES = ['', '.ts', '.tsx', '.mts', '.mjs', '.js', '/index.ts', '/index.mjs']

export async function resolve(specifier, context, next) {
  // ── 1. `@/*` project alias (tsconfig "paths") ────────────────────────────
  if (specifier.startsWith(ALIAS_PREFIX)) {
    const base = path.join(ROOT, specifier.slice(ALIAS_PREFIX.length))
    for (const ext of CANDIDATES) {
      if (existsSync(base + ext)) return next(pathToFileURL(base + ext).href, context)
    }
  }

  // ── 2. Relative extensionless imports ────────────────────────────────────
  // The app is bundled, so its source freely writes `./brokers/interface`
  // without an extension. Node's ESM resolver requires one. This restores the
  // bundler's resolution behaviour so the real modules load unmodified.
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !path.extname(specifier)) {
    const parentDir = context.parentURL
      ? path.dirname(fileURLToPath(context.parentURL))
      : ROOT
    const base = path.join(parentDir, specifier)
    for (const ext of CANDIDATES) {
      if (existsSync(base + ext)) return next(pathToFileURL(base + ext).href, context)
    }
  }

  return next(specifier, context)
}
