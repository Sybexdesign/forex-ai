// scripts/test-ts-register.mjs
// Registers the `@/*` alias resolver so Node can import the real TypeScript
// modules under test. Used via: node --import ./scripts/test-ts-register.mjs …
import { register } from 'node:module'

register('./test-ts-hooks.mjs', import.meta.url)
