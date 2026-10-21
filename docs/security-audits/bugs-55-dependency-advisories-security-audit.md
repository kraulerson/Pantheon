# Security Audit: BUGS #55 (production-dependency advisories in services/control-plane)

Finding: GitHub CI never reached its `npm audit` step (BUGS #54), so the control-plane's production dependencies carried
published advisories that nothing reported. A local `npm audit --omit=dev` on 2026-10-20 found 1 critical, 3 high and
3 moderate. Karl's rulings (2026-10-20): fix `services/control-plane` only (obsidian-mcp is BUGS #57), test-first, check
applicability, exact pins that do not change a major version, land before the Maestro Console F2 deploy.

Base commit 0e026a8. Execution ledger: `.superpowers/sdd/2026-10-20-bugs-55-deps/progress.md` (git-ignored workspace).

## Headline

**Verdict: SHIP.** One advisory reached this code, and the update closes it. A regression test pins it at the exact
patched version. Every other advisory depends on something the service does not use. `npm audit --omit=dev` now reports
0 vulnerabilities.

## Fix

- `fastify` 5.8.5 → 5.12.7 and `@modelcontextprotocol/sdk` 1.29.0 → 1.32.1, both exact pins in `package.json`.
- In-range transitive updates by name (`npm update qs proxy-addr ip-address hono fast-uri`): `proxy-addr` 2.0.8, `qs`
  6.16.1, `ip-address` 10.7.4, `hono` 4.13.13, `fast-uri` 3.1.9. `npm audit fix --omit=dev` was not used, because it
  would have pruned the dev tools from `node_modules`.
- fastify 5.12.7's own ranges add nested copies under `node_modules/fastify/`: `fast-json-stringify` 7.1.2 (with
  `fast-uri` 4.2.3), `ajv` 8.20.0 and `json-schema-traverse` 1.0.0. `process-warning` moves to 5.1.1. The nested
  `fast-json-stringify` 7 is required by fastify's precompiled error serializer; the root 6.4.0 serves only route response
  schemas, of which there are none.
- No source change was needed.

## Applicability

**Reached, nothing exposed: fastify GHSA-p68q-wchp-6fh7 (high).** On 5.8.5, a malformed URL whose method has no route
(PATCH, OPTIONS, TRACE, PROPFIND, SEARCH or QUERY) skipped the root `onRequest` hook that holds the operator and keycard
guards (`src/http/app.ts:325-376`) and went straight to the root not-found handler, which answers a fixed 404
(`app.ts:410-418`). No guarded content was reachable that way, but one ordinary future change (a not-found handler that
serves data) would have made it a real bypass. On 5.12.7 the same request meets the app's `frameworkErrors` handler
(`app.ts:267-269`): 400 `{"error":"bad_request"}`, with no guard, route or handler run. Through Caddy, Go's net/http
already refuses these targets with 400 before the proxy forwards them.

**Not reached:**
- fastify GHSA-667r-xxjv-c9mm, GHSA-hwr6-493r-vm6h, GHSA-9q9j-q6p8-xq58 (high) and GHSA-w2qp-rph6-63g4 (moderate): the
  app declares no route schemas.
- fastify GHSA-3m5p-2c4r-xxw2 (moderate): `trustProxy` is not set.
- fastify GHSA-4mh8-r7rc-xpvc (moderate): no HTTP/2 and no trailers.
- proxy-addr GHSA-jqcg-44mw-7w3h (critical): the flagged copy sits under the MCP SDK's server-side express, which is never
  loaded.
- @modelcontextprotocol/sdk GHSA-6qxp-vccf-f47h (high): no `authProvider` and no OAuth calls (`src/bridge/client.ts:162-169`);
  `dist/server.js` does not load the SDK at all.
- fast-uri (5 high, 1 moderate): used only for schema compilation; there are no schemas.
- hono (5), ip-address (4), qs (2), all moderate: SDK server-side dependencies that `src` never imports. A runtime module
  trace of `dist/server.js` confirms none of them load.

## Findings

| Id | Severity | Finding | Resolution |
|---|---|---|---|
| GHSA-p68q-wchp-6fh7 | High (advisory) | Malformed URL with an unrouted method skipped the guards and reached the not-found handler | Fixed by fastify 5.12.7; pinned by `test/dependency-advisories.test.ts` |
| Review I1 | Important | fastify's own `@fastify/proxy-addr` 5.1.0 has the same IPv4-mapped subnet defect as proxy-addr 2.0.7, with no advisory, so `npm audit` cannot see it (fixed in 5.1.1) | Residual: inert while `trustProxy` is unset |
| Review M1 | Minor | Since fastify 5.9.0 a route parameter longer than 100 characters goes to `frameworkErrors` (400) before the guard | Accepted: still fails closed; no real id is near 100 characters |
| Review M2 | Minor | The test uses PATCH only; if a PATCH route is ever added it stops detecting a downgrade | Residual: add OPTIONS, TRACE or PROPFIND cases, or assert no PATCH route exists |
| Review M4 | Minor | MCP SDK 1.32 follows redirects only within the same origin (POST only on 307/308) | No effect today: the server does not load the SDK |

## Residual

- `@fastify/proxy-addr` 5.1.0 (review I1). Inert while `trustProxy` is unset; `npm update @fastify/proxy-addr` moves it
  to 5.1.2 when convenient.
- The test's single-method shape (review M2).
- Dev-only advisories (vitest and tinypool critical, the typescript-eslint family high, and others) are out of this fix's
  scope; CI's `npm audit --audit-level=high` counts them and stays red until a dev-tool update lands.
- `services/obsidian-mcp` advisories are BUGS #57.
- Whether VM 1093's port 8088 is reachable directly (bypassing Caddy) was not checked.

## Verification

Implementer, from `services/control-plane`: `npm install --save-exact fastify@5.12.7 @modelcontextprotocol/sdk@1.32.1`
exit 0; `npm update qs proxy-addr ip-address hono fast-uri`; `npm ci` exit 0; `npm audit --omit=dev --audit-level=high`
"found 0 vulnerabilities", exit 0; `npm run lint`, `npx tsc -p tsconfig.json --noEmit`, `npm run build` exit 0;
`npm audit signatures`: 460 packages with verified registry signatures; gitleaks on the staged change: no leaks found.

Controller, reproduced on the staged tree: `npm audit --omit=dev --audit-level=high` exit 0; the new test `Tests 5 passed (5)`;
`npm test` exit 0, `Test Files 75 passed | 1 skipped (76)`, `Tests 1380 passed | 5 skipped | 1 todo (1386)` (the 1375
baseline plus the 5 new tests).

Adversarial review (fresh agent, Opus at max effort), in scratch copies:

| fastify | `test/dependency-advisories.test.ts` |
|---|---|
| 5.8.5 | `Tests 5 failed (5)`, each `AssertionError: expected 404 to be 400` |
| 5.12.1 | 5 failed |
| 5.12.2 | 5 passed |
| 5.12.7 (the staged lockfile, `npm ci` exit 0) | `Tests 5 passed (5)` |

With `frameworkErrors` removed (scratch only), all 5 fail on the body. All 12 changed or added lockfile entries resolve from
registry.npmjs.org with sha512 hashes that match `npm view … dist.integrity`; no `dev: true` entry changed. The reviewer read
the fastify 5.9–5.12.7 release notes and the `lib/*` diff: `frameworkErrors` gains bad URLs (the fix) and over-long route
parameters (M1); `setNotFoundHandler`, `exposeHeadRoute`, `onRequest` order, `genReqId` and `bodyLimit` are unchanged.
`@fastify/websocket` 11.2.0 and `@fastify/formbody` 8.0.2 accept fastify 5.x. A 12-file HTTP, websocket, auth and bridge
subset on the staged dependencies: `Tests 295 passed (295)`.
