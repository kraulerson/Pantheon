# Security Audit: BUGS #57 (production-dependency advisories in services/obsidian-mcp)

Finding: `services/obsidian-mcp` (the vault-confined Obsidian MCP server, feature #8: an express app with `express.json()`
and the MCP SDK's `StreamableHTTPServerTransport`) carried 8 published production advisories (1 critical, 2 high,
5 moderate) and was never built, tested or audited by CI. Karl's rulings (2026-10-20/21): fix it by the method of BUGS #55,
before UAT-6; add it to CI afterwards.

Base commit 6594566. Execution ledger: `.superpowers/sdd/2026-10-21-bugs-57-obsidian-deps/progress.md` (git-ignored).

## Headline

**Verdict: SHIP.** One advisory class reaches this server, and the update closes it: an unbounded JSON-RPC batch inside one
in-limit request. A regression test pins it. Every other advisory needs something the server does not load or does not do.
`npm audit --omit=dev` goes from 8 to 0. The review found older problems in the server itself that this update does not
touch; they are recorded as their own BUGS rows (Residual).

## Fix

- Exact pins (the project rule; the three production dependencies used `^` ranges): `@modelcontextprotocol/sdk` 1.32.1
  (was ^1.29.0, locked 1.29.0), `express` 4.22.3 (was ^4.21.2, locked 4.22.2), `zod` 3.25.76 (its locked version).
- In-range transitive updates by name: body-parser 1.20.8, qs 6.16.1, proxy-addr 2.0.8, fast-uri 3.1.9, hono 4.13.13,
  ip-address 10.7.4. 414 lockfile entries before and after; no `dev: true` entry changed.
- No source change.

## Applicability

Evidence: the code (`src/server.ts`, `src/vault.ts`), each advisory (`gh api /advisories/<GHSA>`), and a runtime module and
call trace of `dist/server.js` through a full session plus adversarial inputs. Loaded: express 4, body-parser 1, qs,
proxy-addr, @hono/node-server (one file), ajv, ajv-formats, fast-uri, zod and SDK server files. Not loaded: hono, ip-address,
express-rate-limit, the SDK's nested express 5, any SDK client or auth file.

**Reached, closed by the update: the SDK's unbounded JSON-RPC batch, in the impact class of GHSA-46jr-4wx8-v453 (high).** On
SDK 1.29.0 one POST within `express.json()`'s 100 KB limit (`src/server.ts:120`) could carry any number of messages: 895
`vault_search` calls against a 200-note vault took 6.2 s, streamed 368 MB and peaked at 1.4 GB RSS. SDK 1.30.1 caps a batch
at 100 messages; on 1.32.1 the same request gets 400 `-32600` in about 3 ms. Pinned by `test/dependency-advisories.test.ts`
(a 100-message batch answers 200; a 101-message batch answers 400 with `-32600`), which fails on 1.29.0 with
`expected 200 to be 400` and passes on 1.32.1. The advisory's own fix, `maxToolInputElements`, is opt-in and not set; it would
add little here because every tool input is a scalar (the worst 100 KB argument shape measured took 11 ms and grew RSS by
under 11 MB) and the body limit is 102,400 bytes after decompression.

**Not reached:**
- qs GHSA-x5fp-wj9c-mxmx and GHSA-4mjr-xmp4-gh2g (moderate; the body-parser and express entries are "via qs"): express's
  query parser calls `qs.parse` with `allowPrototypes: true, arrayLimit: 1000`, never `comma: true`; nothing calls
  `qs.stringify`; `express.urlencoded` is not mounted and the JSON parser does not use qs.
- proxy-addr GHSA-jqcg-44mw-7w3h (critical): `trust proxy` is not set (trust function `trustNone`) and `req.ip` is never read.
- fast-uri, 6 advisories (high): called once at startup on Ajv's constant draft-07 meta-schema URI; no request data reaches it.
- hono (5 moderate) and ip-address (4 moderate): not loaded.
- SDK GHSA-6qxp-vccf-f47h and GHSA-6prh-2h8m-c8cw (client-side): the server loads no client code.
- SDK GHSA-22jm-h49p-29qw: no `taskStore`; task methods answer -32601. SDK GHSA-rvq5-wwqv-78pq: no `requireBearerAuth`.

**Behaviour changes, none affecting this server:** SSE keep-alive comments every 15 s; Content-Type checked by parsed media
type; `tools/call` accepted without `arguments`; shorter validation-error text.

## Residual (pre-existing, unchanged by the update; each its own BUGS row)

- #60 unbounded session map: about 53 KB retained per `initialize`, no idle close (5,000 initializes: heap 18 → 285 MB).
- #61 regex ReDoS in `vault_search` (`src/vault.ts:137`, `new RegExp(query)`).
- #62 the listener binds every interface with no authentication and DNS-rebinding protection off (`src/server.ts:161`):
  anything that reaches the port can call `vault_write` without Peta's approval.
- #63 stack traces in error responses (`NODE_ENV` unset) and unbounded `vault_search` output.
- #64 `maxToolInputElements` and an explicit `express.json({ limit })` as hardening.
- fast-uri 3.1.9 was published two days before this change (3.1.8 already clears the advisories); integrity and signatures
  verify.

## Verification

- Implementer: `npm ci` exit 0; `npm audit --omit=dev --audit-level=high` "found 0 vulnerabilities", exit 0;
  `npx tsc -p tsconfig.json --noEmit` exit 0; `npm run build` exit 0; `npm audit signatures`: 363 verified registry
  signatures; `npx eslint src test` exit 0 (`npm run lint` fails on 25 `no-undef` errors in the untouched
  `scripts/e2e-peta-gating.mjs`, present since 8caed24); gitleaks on the staged change: no leaks found.
- RED, in a scratch copy with HEAD's lockfile (SDK 1.29.0): `Tests 1 failed | 1 passed (2)`,
  `AssertionError: expected 200 to be 400`. Reproduced independently by the reviewer.
- GREEN, controller in the repo: the new test `Tests 2 passed (2)`; `npm test` `Test Files 2 passed (2)`,
  `Tests 26 passed (26)`; no server process left running.
- Adversarial review (fresh agent, Opus at max effort): lockfile integrity matches `npm view` for all changed entries; a live
  drive of the staged server (initialize, `tools/list` 4 tools, all four tools, path traversal rejected, DELETE) behaves as on
  HEAD apart from the listed behaviour changes.
