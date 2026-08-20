# Adversarial / Exploratory Probe — UAT Session 2

**Agent role:** "Malicious User" (Phase 2.7 adversarial review)
**Date:** 2026-08-20
**Target:** VM 1093 (`192.168.1.93`) — control-plane admin service `pantheon-admin@pantheon`, Caddy, Peta, LibreChat
**Attacker vantage point:** the operator's Mac (`192.168.1.x`, a *different* LAN host) plus an authenticated SSH shell on the VM for baseline/verification only
**Build under test:** `dist/server.js` (single-service entrypoint, ADR-0007 step-3 split not yet applied), Peta Core 1.2.2, Caddy (two hops)

**Verdict in one line: no SEV-1 was found. Authentication is genuinely fail-closed on every route and every bypass shape I could construct. The findings below are posture, contract and hygiene gaps — two of them SEV-2 — not auth breaches.**

---

## 0. Constraints honoured

| Constraint | Status |
|---|---|
| Do not modify registry contents / the `Mac-Mini` record | **Honoured.** `Mac-Mini` was never created, deleted, disabled, re-provisioned or edited. Its `updatedAt` is byte-identical before and after (`2026-08-19T15:10:55.163Z`). Only two request shapes were ever sent to its id, both of which are rejected *before* any write (`{}` and `{"password":""}` on the provision route). |
| Delete any test record created | **Honoured.** Four records were created during the run (three accidentally by oversized-field payloads, one deliberately as a throwaway PUT/enrolment target). All four deleted, verified twice — via the API and by reading the SQLite file directly. |
| Do not touch the operator's tmux sessions | **Honoured.** No SSH session was opened to `192.168.1.192` at all. The terminal WebSocket was only ever probed *unauthenticated* or with a deliberately wrong credential. No successful provision was run against the Mac. |
| Do not restart services / `docker compose down` / edit files on the VM | **Honoured.** Read-only inspection only. One temp file (`/tmp/adv-big.json`) was written for the body-limit test and deleted in the same script. |
| Do not brute-force the operator passphrase | **Honoured.** The rate-limit probes used literal non-guess strings (`NOT-A-GUESS-RATE-LIMIT-PROBE-<n>`, `NOT-A-GUESS-CADDY-PROBE-<n>`). No dictionary, no permutation, no candidate passphrase was ever submitted. |
| Do not touch `docs/research/` or `services/control-plane` source | **Honoured.** Source was read, never written. The only file written by this agent is this report. |
| Never print/echo/log a secret value | **Honoured.** Every authenticated request sourced `.env.local` *on the VM* and fed the header to `curl --config -` on stdin, so the token never entered this Mac, never entered a command line, and never entered VM process argv. Secret *lengths* and *character classes* are reported (see §10) — no value, no prefix, no substring. |

---

## 1. Network posture (TM-007 / M2)

**Method:** TCP connect scan from this Mac against `192.168.1.93`, cross-checked against `ss -ltnp`, `nft list ruleset` and `iptables -L -n` on the VM.

```
nc -z -G 3 -w 3 192.168.1.93 <port>
```

| Port | Service | From this Mac | Bound on VM | Verdict |
|---|---|---|---|---|
| 3002 | Peta Core | closed/filtered | `127.0.0.1:3002` | **PASS** |
| 5433 | Peta Postgres | closed/filtered | `127.0.0.1:5433` | **PASS** |
| 27017 | MongoDB | closed/filtered | container-internal, not published | **PASS** |
| 7700 | Meilisearch | closed/filtered | container-internal, not published | **PASS** |
| 3080 | LibreChat | closed/filtered | container-internal, not published | **PASS** |
| 80 | Caddy | open → 308 to HTTPS | `0.0.0.0:80` | PASS |
| 443 | Caddy (LibreChat) | open | `0.0.0.0:443` | PASS |
| 8443 | Caddy (admin console) | open, 401 unauth | `0.0.0.0:8443` | PASS |
| **8088** | **control-plane, raw** | **OPEN** | **`0.0.0.0:8088`** | **FINDING F-1** |

The four ports the brief asked about are correctly contained: Docker's NAT rules DNAT 3002/5433 only for `ip daddr 127.0.0.1`, and 27017/7700 are not published at all. Mongo and Meilisearch are reachable only across the `br-faa1111c346d` bridge.

`8088` is a different story — see F-1.

There is **no host firewall**: `iptables -L -n` shows `Chain INPUT (policy ACCEPT)` with zero rules; `ufw` is not installed. Every host-bound listener is therefore LAN-reachable by default.

---

## 2. FINDING F-1 (SEV-2) — the admin control plane is LAN-reachable in cleartext on 8088, bypassing Caddy entirely

**The brief's premise is wrong.** The task described the console as running "on `127.0.0.1:8088`". It does not.

```
$ ssh pantheon@192.168.1.93 'ss -ltnp | grep 8088'
LISTEN 0 511 0.0.0.0:8088 0.0.0.0:* users:(("MainThread",pid=389707,fd=24))

$ grep -E '^(HOST|PORT)=' .../services/control-plane/.env.local
PORT=8088
HOST=0.0.0.0
```

`src/server.ts:127` also defaults to `0.0.0.0` when `HOST` is unset, so this is the shipped default, not a local misconfiguration. The public `/help` guide documents it explicitly: *"PORT / HOST — Where the console listens. Default 8088 on all interfaces."*

**Observed from this Mac (a different machine on the LAN):**

```
$ curl -s -o /dev/null -w '%{http_code}' http://192.168.1.93:8088/login
200
$ curl -s -D - -o /dev/null http://192.168.1.93:8088/login
HTTP/1.1 200 OK
content-type: text/html
content-length: 606
Date: ...
Connection: keep-alive
```

Note what is *absent* from that response: no `strict-transport-security`, no `x-content-type-options`, no `referrer-policy`, no `x-frame-options`. Compare the same page through Caddy (§6) which carries all four. Every one of the Bible §11 security headers is a Caddy-layer header, and port 8088 is a complete bypass of that layer.

**Why it exists (and why the fix is cheap):** Caddy runs in a container and reaches the console via `host.docker.internal` → `host-gateway`. Binding `127.0.0.1` would break that. But `host-gateway` resolves to `172.18.0.1`, the `br-faa1111c346d` bridge address — not `0.0.0.0`:

```
$ docker inspect pantheon-caddy-1 --format '{{.HostConfig.ExtraHosts}}'
[host.docker.internal:host-gateway]
$ ip -4 -o addr show
lo 127.0.0.1/8 | eth0 192.168.1.93/24 | docker0 172.17.0.1/16 | br-faa1111c346d 172.18.0.1/16
```

**Exploit narrative.** An attacker with any foothold on the LAN — a compromised IoT device, a guest on the wifi, a laptop with malware — does not need to find `pantheon-admin.ferrumcorde.com` or trust Caddy's internal CA. They connect to `http://192.168.1.93:8088` and get the identical admin surface with TLS removed. From there:

1. **Passive credential capture.** Any script, cron job, or `curl` one-liner that authenticates to `:8088` with `Authorization: Bearer $ADMIN_API_TOKEN` puts a 256-bit admin token on the wire in plaintext, recoverable by anyone who can ARP-spoof or span the segment. Same for `POST /api/dev-machines/:id/provision`, whose body carries **the target machine's login password** — i.e. the operator's Mac password — in cleartext.
2. **Operator misdirection.** The public `/help` page tells the reader the console listens on 8088 on all interfaces. An operator who follows that hint and visits `http://192.168.1.93:8088/login` submits the 24-character operator passphrase in cleartext. (`PANTHEON_SECURE_COOKIES=true` means the resulting cookie carries `Secure`, so the *browser* then refuses to send it back over http and login appears "broken" — but the passphrase is already on the wire, and a scripted attacker who lifted the `Set-Cookie` value replays it over HTTPS without caring about the attribute.)
3. **Unmonitored attack surface.** Because there is no request logging at all (F-3), all of the above, and any volume of probing, is invisible.

Auth itself holds on 8088 — I confirmed 401/403 on every guarded route over that port — so this is not a breach. It is the removal of a defence layer the project explicitly built and documents as present.

**Severity: SEV-2.** Significant security gap with a workaround (use the HTTPS name). Not SEV-1 because the guard does not fail open.

**Suggested fix:** set `HOST=172.18.0.1` in `.env.local` (Caddy keeps working; the LAN loses reach), or add an INPUT rule accepting 8088 only from `172.18.0.0/16` and `127.0.0.1`. Either change should be paired with correcting the `/help` text.

---

## 3. Authentication — every guarded route, every credential shape

### 3.1 Unauthenticated route sweep (direct to `:8088`, `Accept: */*`)

```
curl -s -o /dev/null -w '%{http_code}' http://192.168.1.93:8088<path>
```

| Path | Code | Body | Verdict |
|---|---|---|---|
| `/` | 401 | `{"error":"unauthenticated"}` | PASS |
| `/harness` | 401 | same | PASS |
| `/harness/terminal/Mac-Mini` | 401 | same | PASS |
| `/admin/config` | 401 | same | PASS |
| `/api/dev-machines` | 401 | same | PASS |
| `/api/backends` | 401 | same | PASS |
| `/api/service-endpoints` | 401 | same | PASS |
| `/api/mcp-servers` | 401 | same | PASS |
| `/approvals` | 401 | same | PASS |
| `/inspector/x/latest` | 401 | same | PASS |
| `/terminal/Mac-Mini` (WS) | 401 | same | PASS |
| `/login` | 200 | login form | PASS (intended public) |
| `/help` | 200 | user guide | PASS (intended public) — but see F-9 |
| `/assets/xterm.js` | 200 | 488663 B | PASS (intended public) |
| `/assets/xterm.css` | 200 | 7112 B | PASS (intended public) |
| `/v1/chat/completions` | 404 | Fastify route-not-found | see F-10 |

The 401 body is a fixed 27-byte `{"error":"unauthenticated"}` on every route — no route name, no reason distinction, no metadata (TM-012's "no metadata leak" requirement). **PASS.**

### 3.2 Credential shapes against `/api/dev-machines`

| Header sent | Code | Expected | Verdict |
|---|---|---|---|
| *(none)* | 401 | 401 | PASS |
| `Authorization: Bearer ` (empty value) | 401 | 401 | PASS |
| `Authorization: Bearer` (no separator) | 401 | 401 | PASS |
| `Authorization: bearer <junk>` (lowercase scheme) | 401 | 401 | PASS — `startsWith("Bearer ")` is case-sensitive, fails closed |
| `Authorization: Basic YWRtaW46YWRtaW4=` | 401 | 401 | PASS |
| `Authorization: Bearer wrong-token-value-1234567890` | **403** | 403 | PASS |
| `Authorization: Bearer abc` (short) | **403** | 403 | PASS |
| two `Authorization` headers (`Bearer x`, `Bearer y`) | 403 | 4xx | PASS — Fastify joins them; no confusion bypass |
| `Cookie: pantheon_session=deadbeefdeadbeefdeadbeef` (forged) | 401 | 401 | PASS |
| `Cookie: pantheon_session=` (empty) | 401 | 401 | PASS |
| `X-Forwarded-For: 127.0.0.1` | 401 | 401 | PASS — no trusted-proxy bypass |
| `X-Real-IP: 127.0.0.1` | 401 | 401 | PASS |

Truncated / extended token variants were exercised on the VM against the real token's length boundary via the length check in `operatorGuard`; `Buffer.length` mismatch short-circuits to 403 before `timingSafeEqual`, and equal-length-but-wrong also yields 403. The missing-vs-rejected distinction (401 vs 403) matches the documented contract exactly. **PASS.**

### 3.3 HTTP methods on a guarded route (unauthenticated)

`GET, HEAD, POST, PUT, DELETE, PATCH, OPTIONS, TRACE` → **all 401.** The `onRequest` hook runs before routing, so unrouted methods are refused rather than 404'd. **PASS.**

### 3.4 Browser-shaped requests

`Accept: text/html` on `/`, `/harness`, `/admin/config`, `/api/dev-machines` → **302 → `/login`** in every case, `content-length: 0`. No metadata leaked in the redirect. **PASS.**

### 3.5 Guard-bypass / path-normalisation attempts

The interesting attack here is the guard's exemption check:
`PUBLIC_PATHS.has(req.routeOptions.url ?? req.url.split("?")[0] ?? "")`.
When a route matches, `routeOptions.url` is the *route pattern*; when nothing matches it degrades to the raw path. I tried to make an admin route present a public pattern, and to make a near-miss on a public path fall through unguarded. All 21 attempts (`curl --path-as-is`):

| Request | Code | Verdict |
|---|---|---|
| `/login/` | 401 | PASS (trailing slash → no route → guarded on raw path) |
| `//login` | 401 | PASS |
| `/LOGIN`, `/Login` | 401 | PASS (case-sensitive routing fails *closed*) |
| `/login%2f` | 401 | PASS |
| `/login/../admin/config` | 401 | PASS |
| `/assets/xterm.js/../../admin/config` | 401 | PASS |
| `/assets/../admin/config` | 401 | PASS |
| `/help/../admin/config` | 401 | PASS |
| `/%2e%2e/admin/config` | 401 | PASS |
| `/admin/config/`, `/admin//config`, `/./admin/config` | 401 | PASS |
| `/api/dev-machines/`, `/api/dev-machines?x=/login` | 401 | PASS |
| `/harness;/login` (path-param smuggle) | 401 | PASS |
| `/harness%00/login` (null-byte truncation) | 401 | PASS |
| `/harness#/login` | 401 | PASS |
| `/admin/config%20` | 401 | PASS |
| `/%61dmin/config`, `/api/%64ev-machines` (percent-encoded route chars) | 401 | PASS |
| absolute-URI request line (`--request-target http://…/admin/config`) | 401 | PASS |
| `Host: localhost` override | 401 | PASS |
| `/api%0d%0aX-Injected:%20yes` (CRLF in path) | 401, no injected header | PASS |
| `/harness%0d%0aSet-Cookie:%20evil=1` with `Accept: text/html` | 302, `location: /login` only — no injected `Set-Cookie` | PASS |

**No bypass found.** The `?? req.url` fallback is the right way round: an unrouted path is guarded, not exempted.

### 3.6 Terminal WebSocket (`/terminal/:logicalName`)

```
curl -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: <rfc6455-example-ws-key>" \
     http://192.168.1.93:8088/terminal/Mac-Mini
```

| Variant | Code | Verdict |
|---|---|---|
| unauthenticated, direct 8088 | **401** `{"error":"unauthenticated"}` — no 101, no upgrade | PASS |
| wrong bearer | **403** | PASS |
| forged session cookie (`00000000…`) | **401** | PASS |
| unauthenticated via Caddy (`https://pantheon-admin.ferrumcorde.com/terminal/Mac-Mini`) | **401** | PASS |
| unauthenticated with `?session=1` (reattach-hijack attempt) | **401** | PASS |

The upgrade is refused before the gateway is reached, so no SSH connection is ever attempted for an unauthenticated caller. **This is the TM-020 SEV-1 surface and it is clean.** I did not test with a valid credential, by constraint — a successful handshake would open a real PTY on the operator's Mac.

### 3.7 Cross-hostname reachability

The two hostnames both resolve to `10.100.23.52` (the household edge proxy), which fronts the VM — `via: 2.0 Caddy` + `via: 1.1 Caddy` confirms two hops.

I tried to reach the admin console through the **LibreChat** hostname:

| `https://pantheon.ferrumcorde.com<path>` | Code | Content |
|---|---|---|
| `/harness` | 200 | **LibreChat SPA index** (8077 B, `<title>LibreChat</title>`) |
| `/admin/config` | 200 | LibreChat SPA index (8077 B, byte-identical) |
| `/terminal/Mac-Mini` | 200 | LibreChat SPA index (8077 B) |
| `/login` | 200 | LibreChat SPA index (8077 B) — *not* the operator login form |
| `/help` | 200 | LibreChat SPA index (8077 B) |
| `/api/dev-machines` | 404 | LibreChat API router |

The 200s are LibreChat's client-side-routing catch-all, confirmed by title, byte-size and absence of any harness marker (`data-open-terminal`, `Operator password`, `Mac-Mini`, `karl@`). **No admin content is served on the chat hostname. PASS** — but the 200s are a trap for a future tester, so they are recorded here explicitly.

Reaching the admin site by Host header alone also fails closed: `https://192.168.1.93:443` with `Host: admin.pantheon.lan` correctly routes to the admin site and returns **401** for `/api/dev-machines`. `https://192.168.1.93:8443` with an unmatched Host returns Caddy's empty `200` with zero bytes — no content, no leak.

Proxy-header spoofing through Caddy (`X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Real-IP`, empty `Authorization`) → **401 in every case.** The app trusts none of them. **PASS.**

---

## 4. Public routes — do they leak?

### `/login` (606 B)
Static form, no CSRF token, no version banner, no build info, no hostnames. Login failure re-renders the same page with `<p role="alert"><strong>Incorrect password.</strong></p>` — identical for every wrong input, no user enumeration (there is no username). **PASS.**

### `/assets/xterm.js`, `/assets/xterm.css`
Verified byte-identical to the vendored upstream library:

```
$ curl -s http://127.0.0.1:8088/assets/xterm.js | sha256sum
14903579ff54664cd72f8e8699e6961a6272c21863ec1c3b118cdc8af5d4a972  -
$ sha256sum node_modules/@xterm/xterm/lib/xterm.js
14903579ff54664cd72f8e8699e6961a6272c21863ec1c3b118cdc8af5d4a972  ...
```

Stock UMD bundle, no injected config, no tokens, no endpoints. **PASS.**

### `/help` (23179 B) — **FINDING F-9 (SEV-3)**

No secret *values* leak — I grep-scanned for `BEGIN … PRIVATE`, `ssh-rsa`, `ssh-ed25519`, bearer values and key material and found none. The code comment's claim ("carries no credentials or key material") is accurate.

But it is a complete operations map, served to anyone on the LAN with no authentication:

| Disclosed | Context in the page |
|---|---|
| `192.168.1.93` | "Everything runs on one virtual machine — VM 1093 (192.168.1.93)" |
| `192.168.1.89`, `192.168.1.192`, `192.168.1.206`, `10.100.23.79`, `10.100.23.90`, `10.100.23.88` | example endpoints — but they are the *real* configured ones (Alden-1, the Mac mini, the 7900XTX box, Qdrant, Bridge) |
| `/home/pantheon/.pantheon/keys` | "Harness SSH key — owner-only" |
| `/opt/pantheon/pantheon-harness/services/control-plane/.env.local` | "Console settings and secrets" |
| `/opt/pantheon/pantheon-harness/scripts/set-operator-passphrase.sh` | the exact passphrase-reset command |
| `services/control-plane/data/control-plane.db` | registry location |
| `ADMIN_API_TOKEN`, `PANTHEON_OPERATOR_PASSWORD`, `PETA_ADMIN_TOKEN`, `JWT_SECRET`, `MEILI_MASTER_KEY`, `CREDS_*` | names and purposes of every secret |
| *"PORT / HOST — Where the console listens. Default 8088 on all interfaces."* | tells the reader exactly where F-1 is |

**Exploit narrative.** This is pre-written reconnaissance. An attacker who gets *any* code execution as `pantheon` — a dependency compromise, a future SSRF, a stolen SSH key — does not have to explore. The guide already told them the private key is at `/home/pantheon/.pantheon/keys`, that the registry is a SQLite file at a named path, and which env file holds every token. Combined with F-12 (the key is a plaintext file), the shortest path from "code execution as `pantheon`" to "interactive shell on the operator's Mac as `karl`" is two `cat`s and an `ssh`, with no discovery phase.

The ruling of 2026-08-19 made this page public on purpose so the chat page's Help link always resolves. That is a reasonable UX decision. The recommendation is narrow: **strip the infrastructure sections** (host addresses, filesystem paths, the maintenance-command block, the env-var tables) into a second page behind the guard, and leave the operator-facing "how do I use this" content public.

**Severity: SEV-3.** No credential exposed; it accelerates an attacker who already has a foothold rather than creating one.

---

## 5. Input validation — `POST /api/dev-machines` (54 payloads)

All requests authenticated, sent to `http://127.0.0.1:8088` from the VM.

### 5.1 Rejections (**PASS** — 400, no partial write, no stack trace)

| Class | Payloads tried | Result |
|---|---|---|
| Missing fields | `{}`, `{logicalName}`, `{logicalName,host}`, `{logicalName,user}` | 400 `logicalName is required` / `host is required` / `user is required` |
| `logicalName` path traversal | `../../etc/passwd`, `/etc/shadow` | 400 `malformed logicalName (letters/digits/._- only)` |
| `logicalName` argv injection | `-oProxyCommand` | 400 (leading `-` rejected — the documented option-injection guard) |
| `logicalName` control chars | embedded space, ` `, `\n` | 400 |
| `logicalName` unicode | `Mac‑Mini` (non-breaking hyphen homoglyph), `adv‮test` (RTL override) | 400 — homoglyph cannot shadow the real `Mac-Mini` |
| `logicalName` empty/whitespace/wrong type | `""`, `"   "`, `123`, `["a"]`, `{"a":1}` | 400 |
| `logicalName` duplicate | `Mac-Mini` | 400 `dev machine logicalName already in use: Mac-Mini` — **no overwrite of the operator's record** |
| `host` shell metacharacters | `10.0.0.1; id`, `$(whoami)`, `` `id` ``, `10.0.0.1\|nc 1.2.3.4 1` | 400 `malformed host` |
| `host` malformed | `10.0.0.1:22`, `ssh://10.0.0.1`, `10.0.0.1\r\nX: y`, `-oProxyCommand=id` | 400 |
| `user` injection | `root; id`, `-oProxyCommand=id`, `bob@evil`, `bob root`, `null` | 400 `malformed user` / `user is required` |
| `port` type/range | `"22"`, `22.5`, `-1`, `0`, `65536`, `"0x16"`, `null`, `true`, `99999999999999999999` | 400 with the type named, e.g. `port must be a whole number 1-65535 (got string: "22")` |
| `sshKeyHandle` custody guard | `-----BEGIN OPENSSH PRIVATE KEY-----`, `../../../etc/passwd`, `a:b`, 200×`a` | 400 `must be an opaque vault reference, not raw key material` |
| Body type confusion | `[…]`, `"advtest7"`, `42` | 400 `logicalName is required` |

The strict `port` guard is genuinely strict — the string `"22"` is rejected as hard as `70000`, exactly as the code comment claims. Shell metacharacters, `ssh` option injection and path traversal are all refused by grammar before any value reaches an argv or a filesystem path. **This is the strongest part of the system.**

### 5.2 FINDING F-5 (SEV-3) — no maximum length on `logicalName` or `host`

```
POST /api/dev-machines
{"logicalName":"AAAA…"(10000 chars),"host":"10.0.0.1","user":"bob"}
→ 201 Created, id 2b382def-fb85-408b-bd95-2ee35cb33e7b

POST /api/dev-machines
{"logicalName":"advtest2","host":"aaaa…"(5000 chars),"user":"bob"}
→ 201 Created, id 3216813b-efe3-44c1-9e36-7a051edf5da5
```

`LOGICAL_NAME_RE`/`HOST_RE` bound the *character set* but not the *length*. `sshKeyHandle` is correctly capped at 128 chars by `KEY_HANDLE_RE`; the two identity/connectivity fields are not.

**Exploit narrative.** An authenticated admin (or anything that gets the token) can write unbounded strings into the registry. Each such row is then rendered into the Config page and the harness frame, and injected into the New Session dropdown — a handful of 10 KB names makes both pages unusable and the machine-picker unnavigable, a self-inflicted denial of the admin UI that can only be undone through the API. It also inflates the SQLite file without limit. Escaping is intact (§5.4) so this is availability/robustness, not injection.

**Severity: SEV-3.** Requires admin credentials; no confidentiality or integrity impact.
**Suggested fix:** cap `logicalName` at ~64 and `host` at 253 (the DNS maximum) inside `assertLogicalName` / `assertHost`.

*(Both records were deleted — see §9.)*

### 5.3 `port: 1e3` — not a bug

`{"port":1e3}` → **201**, stored as `1000`. This is correct: JSON `1e3` *is* the number 1000 and `Number.isInteger(1000)` is true. Recorded so a future reader does not mistake it for coercion. The record was deleted.

### 5.4 Stored-XSS attempt — **PASS**

`logicalName`, `host` and `user` are constrained to `[A-Za-z0-9._-]` / hostname grammar, so no markup can reach them. Independently, all three renderers (`config-page.ts`, `harness-frame.ts`, `terminal-tab.ts`) escape all five HTML-significant characters (`&`, `<`, `>`, `"`, `'`) through a shared `esc()` applied at every interpolation, including `data-*` attribute values and `id` attributes. `displayName` on backends/service-endpoints accepts free text but goes through the same `esc()`. **No XSS vector found.** (I verified this by reading the renderers rather than by injecting into the live registry, to avoid writing rows outside the dev-machine scope the brief permitted.)

### 5.5 Body limits and content-types — **FINDING F-4**

See §6.

---

## 6. Input validation — `PUT /api/dev-machines/:id`

Run against a throwaway record (`advprobe-tmp`, `127.0.0.1:1`, user `nobodyx`) created for the purpose and deleted afterwards. **No PUT with valid values was ever sent to `Mac-Mini`** — such a PUT would reset `provisioned` to false and clear its key handle, which the brief forbids.

### 6.1 Invalid values — **PASS** (400, record unchanged)

`{"host":"1.2.3.4; id"}`, `{"host":"1.2.3.4:22"}`, `{"host":""}`, `{"host":null}`, `{"port":"2222"}`, `{"port":70000}`, `{"port":-5}`, `{"user":"root;id"}`, `{"user":"-oProxyCommand=id"}` → **all 400**, all with the same grammar messages as POST. Validation runs before `repo.updateDevMachine`, so no partial write is possible.

### 6.2 Forgery / immutability — **PASS**

| Payload | Code | Effect on record |
|---|---|---|
| `{"logicalName":"Mac-Mini"}` | 200 | **ignored** — still `advprobe-tmp`. The immutable binding handle (#14a) cannot be rebound, and the operator's record cannot be shadowed. |
| `{"provisioned":true}` | 200 | **ignored** — still `false`. TM-020 invariant #4 holds: `markProvisioned` is the only writer. |
| `{"sshKeyHandle":"harness"}` | 200 | **ignored** — still `""`. A caller cannot forge custody of the harness key onto an arbitrary machine. |
| `{"id":"00000000-…"}` | 200 | **ignored** |
| `{"createdAt":"1970-01-01T…"}` | 200 | **ignored** |

This is the single most important result in the PUT matrix: **an authenticated attacker cannot point a forged `sshKeyHandle` at a machine they control, nor mark it provisioned, nor steal the `Mac-Mini` logical name.** The `next` object is built field-by-field from `existing` rather than spread from the patch, so unknown keys are structurally unreachable.

### 6.3 FINDING F-6 (SEV-3) — `enabled` is silently coerced

| Payload | Code | Resulting `enabled` |
|---|---|---|
| `{"enabled":"banana"}` | **200** | `false` |
| `{"enabled":"true"}` | **200** | `false` |
| `{"enabled":1}` | **200** | `false` |

`updateDevMachine` computes `patch.enabled === undefined ? existing.enabled : patch.enabled === true`. Any present-but-non-`true` value silently means "disable", and the API answers 200 OK.

This directly contradicts the design doctrine stated three files away, in `app.ts`:

> *"The registry's guards are strict on purpose — `assertPort` rejects the string `"22"` exactly as hard as the number 70000, because silent coercion deep in the domain is how bad values get laundered."*

`port` is protected by that rule. `enabled` — the field that decides whether a machine may be used at all — is not.

**Exploit narrative.** A JSON client that sends `{"enabled":"true"}` (a very common mistake, and exactly what a naive form-to-JSON bridge produces) gets a 200 and believes the machine is enabled. It is disabled. Because there is no logging (F-3), nothing records that a machine was turned off or by what request. The failure direction is *closed* — it disables rather than enables — so there is no privilege gain, which is why this is not SEV-2.

**Severity: SEV-3.**
**Suggested fix:** add `assertEnabled` mirroring `assertPort` — reject any `enabled` that is present and not a boolean.

### 6.4 FINDING F-4 (SEV-3) — framework-level client errors are masked as `500`

The contract in the brief ("every rejection must be a 400") and in `app.ts` ("validation errors → 400 with no mutation") is broken for everything that fails *before* the handler, because `setErrorHandler` maps anything that is not a `ValidationError` to `500 internal_error` — including Fastify's own 4xx errors.

| Request | Observed | Should be |
|---|---|---|
| `PUT` with **no body** | **500** `{"error":"internal_error"}` | 400 |
| `PUT` with body `null` | **500** | 400 |
| `PUT` with malformed JSON (`{"host":`) | **500** | 400 (`FST_ERR_CTP_INVALID_JSON`) |
| `PUT` with `Content-Type: application/xml` | **500** | 415 (`FST_ERR_CTP_INVALID_MEDIA_TYPE`) |
| `POST` with 1.1 MB body | **500** | 413 (`FST_ERR_CTP_BODY_TOO_LARGE`) |
| `POST` with `{"__proto__":{"polluted":true},…}` | **500** | 400 |
| `POST` with `{"constructor":{"prototype":{"x":1}}}` | **500** | 400 |
| `POST` with body `null` | **500** | 400 |

Two things are worth separating here:

- **The security half is fine.** Prototype-pollution payloads are *rejected*, not absorbed — Fastify's `secure-json-parse` throws on `__proto__`/`constructor` before the handler sees them, and no pollution occurred (subsequent requests behaved normally). The 1.1 MB body was refused, so the 1 MB `bodyLimit` is enforced. Every 500 body is the fixed sanitised `{"error":"internal_error"}` — **no stack trace, no exception text, no file path, no library name in any of them** (§8). Fail-closed holds throughout.
- **The contract half is broken.** A caller cannot distinguish "I sent something malformed, fix my request" from "the server is broken". Anything monitoring 5xx rate will alarm on client mistakes, and — combined with F-3 — a burst of malformed requests from an attacker is indistinguishable from a service fault and is recorded nowhere.

The `null`-body and no-body cases have a second root cause: `updateDevMachine` dereferences `patch.host` on `undefined`/`null`, throwing a `TypeError` that escapes as 500. That is a genuine unhandled input path, not just an error-handler mapping choice.

**Severity: SEV-3.**
**Suggested fix:** in `setErrorHandler`, honour `err.statusCode` when Fastify has already assigned a 4xx before falling through to 500; and guard `updateDevMachine`/`createDevMachine` against a non-object body with a `ValidationError`.

### 6.5 FINDING F-7 (SEV-4) — mistyped bodies return `200` with no change

| Request | Observed |
|---|---|
| `PUT` body `[]` (array) | **200**, record unchanged |
| `PUT` body `host=1.2.3.4` with `Content-Type: text/plain` | **200**, record unchanged |
| `PUT` body `{"host":"1.2.3.4"}` with the default urlencoded content-type | **200**, record unchanged |

Fastify's built-in `text/plain` parser hands the handler a string; `patch.host` on a string or array is `undefined`, so every field keeps its old value and the response is a cheerful 200 with an unmodified record. A client that mis-set its content-type gets a success response for a write that did not happen. No security impact (nothing is written), but it is a silent no-op success. **SEV-4.**

*(One nuance worth recording: none of these no-op shapes trip F-6, because `patch.enabled` is `undefined` in all of them and the existing value is preserved. Only an explicit `enabled` key triggers the coercion.)*

### 6.6 FINDING F-8 (SEV-4) — wrong status and reflected input on unknown id

```
PUT /api/dev-machines/does-not-exist    → 400 {"error":"validation_error","detail":"dev machine not found: does-not-exist"}
PUT /api/dev-machines/..%2f..%2fetc     → 400 {"error":"validation_error","detail":"dev machine not found: ../../etc"}
```

Should be **404**, not 400 — "not found" is not a validation failure. The caller-supplied id is echoed into the body; it is JSON-encoded and served as `application/json`, so this is not an XSS vector, and the traversal string is used only as a map key and never touches the filesystem — **traversal is contained**. Cosmetic contract issue. **SEV-4.**

---

## 7. The enrolment route — `POST /api/dev-machines/:id/provision`

Probed against the throwaway record (target `127.0.0.1:1`, guaranteed connection-refused) and, for the two guaranteed-400 shapes only, against `Mac-Mini`. **No successful provision was attempted against the operator's Mac.**

| Payload | Code | Body | Verdict |
|---|---|---|---|
| no body | 400 | `{"error":"validation_error","detail":"a machine password is required"}` | PASS |
| `{}` | 400 | same | PASS |
| `{"password":""}` | 400 | same | PASS |
| `{"password":null}` | 400 | same | PASS |
| `{"password":12345}` | 400 | same | PASS — non-string coerced to `""`, refused |
| `{"password":["a"]}` | 400 | same | PASS |
| `password=x` with `Content-Type: text/plain` | 400 | same | PASS — body is a string, `.password` is `undefined` |
| nonexistent id | **404** `{"error":"not_found"}` | | PASS (correct status here, unlike PUT) |
| **`Mac-Mini` + `{}`** | 400 | required-password message | PASS — refused before any SSH |
| **`Mac-Mini` + `{"password":""}`** | 400 | required-password message | PASS — refused before any SSH |

### 7.1 Password non-disclosure — **PASS**

I sent a sentinel value (`SENTINEL-PW-9f3a2b-DO-NOT-USE`) to a target that refuses the connection, then searched the response and the journal:

```
response: {"error":"enrollment_failed","detail":"could not authenticate to advprobe-tmp
           (nobodyx@127.0.0.1:1) with the supplied password"}
OK: sentinel password absent from response
journal matches for sentinel: 0
```

The upstream `ssh2` error text is replaced rather than forwarded, exactly as `enrollment.ts` documents. The sentinel appears nowhere in the response body, nowhere in the service journal, and the record was left unprovisioned (`provisioned: false`, `sshKeyHandle: ""`) — `provisionAndRecord` only writes on success. **§8/TM-008 holds.**

The error detail does echo `user@host:port`, but that is registry data the authenticated caller already possesses. Not a leak.

### 7.2 Observation — whitespace-only password reaches the wire

`{"password":"   "}` is **not** caught by the empty-password guard (which tests `=== ""`), so it proceeds to a live SSH password authentication against the target. Arguably correct — a password may legitimately contain only spaces — but worth knowing: a fat-fingered space in the Config page form produces a real failed SSH auth attempt against the operator's Mac, which on a hardened target counts toward lockout/`fail2ban`. Recorded as an observation, not a finding.

### 7.3 Observation — the enrolment route is an authenticated SSRF / port-scan oracle

An authenticated admin can register a machine pointing at any reachable `host:port` and read the error text to distinguish "SSH answered and rejected the password" from other failures, mapping internal services from the VM's vantage point. Since an admin already has a full terminal via `/terminal/:logicalName`, this grants no privilege they do not already hold. Not a finding; recorded for completeness.

---

## 8. Headers, error hygiene, and TLS

### 8.1 Security headers through Caddy — **PASS on both hostnames**

`https://pantheon-admin.ferrumcorde.com/` (401) and `/login` (200):

```
strict-transport-security: max-age=31536000; includeSubDomains
x-content-type-options: nosniff
referrer-policy: no-referrer
x-frame-options: DENY
via: 2.0 Caddy / via: 1.1 Caddy
```

`https://pantheon.ferrumcorde.com/` (200):

```
strict-transport-security: max-age=31536000; includeSubDomains
x-content-type-options: nosniff
referrer-policy: no-referrer
x-frame-options: SAMEORIGIN
x-robots-tag: noindex
cache-control: no-cache, no-store, must-revalidate
```

All four required headers present on both. `X-Frame-Options: DENY` on the admin console (correct — it must not be framed) and `SAMEORIGIN` on the chat UI (correct — the harness frame hosts it). `Server` is suppressed by the `-Server` directive. `https://192.168.1.93:8443` carries the same set plus `alt-svc: h3`. Plain HTTP on 80 → `308` to HTTPS. **PASS.**

The exception is port 8088, which carries none of them — that is F-1, not a Caddy defect.

### 8.2 Error-response hygiene — **PASS**

Across every 4xx and 5xx produced in this entire probe — 54 POST payloads, 30 PUT payloads, 9 enrolment payloads, 21 path-bypass attempts, oversized headers, oversized URLs, 300 query parameters, CRLF injection, malformed JSON, unsupported media types, an over-limit body — **not one response contained a stack frame, an exception class name, a file path, a line number, a library name, or a SQL fragment.** Every 5xx is the fixed `{"error":"internal_error"}`; every 400 is `{"error":"validation_error","detail":"<domain message>"}` where the detail is a hand-written grammar message. Prototype-pollution rejections are indistinguishable from any other 500. **TM-008 holds on the error surface.**

### 8.3 FINDING F-10 (SEV-4) — Fastify 404 body reachable unauthenticated

```
$ curl http://192.168.1.93:8088/v1/chat/completions
{"message":"Route GET:/v1/chat/completions not found","error":"Not Found","statusCode":404}
```

`/v1/chat/completions` is in `PUBLIC_PATHS`, so the guard skips it — but the pre-processor is not currently mounted, so it falls through to Fastify's default 404 handler, which names the method and route. This is the **only** unauthenticated 404 on the service (every other unrouted path is caught by the guard and returns 401). It tells an attacker that the chat entry-point exists in the design but is currently unmounted. Marginal. **SEV-4.**

### 8.4 FINDING F-11 (SEV-4) — no `Cache-Control` and no CSP on admin HTML

Authenticated `/admin/config` (6716 B) and `/harness` (8460 B) return:

```
HTTP/1.1 200 OK
content-type: text/html
content-length: 6716
```

No `Cache-Control: no-store`, no `Content-Security-Policy`. The config page contains the full registry — every machine's host, port and user, every backend endpoint. Caddy adds `no-store` to the *chat* host but not the admin host. Escaping is solid so CSP is defence-in-depth, but `no-store` on a page listing internal infrastructure is cheap and standard. **SEV-4.**

### 8.5 Abuse-shaped requests — **PASS**

16 KB header, 12 KB URL, 300 query parameters, CRLF in path, response-splitting attempt via the login redirect → all **401**, no injected headers, no crash, service responsive throughout.

---

## 9. Rate limiting, logging and credential strength

### 9.1 FINDING F-2 (SEV-3) — no rate limiting or lockout anywhere

```
60 sequential POST /login with deliberately-invalid passwords, direct to :8088
→ 60 × 401, elapsed 0.72 s, 83.4 req/s
→ no 429, no Retry-After, no delay, no lockout
→ /login and /api/dev-machines still serving normally afterwards
```

```
30 sequential POST /login through Caddy (https://192.168.1.93:8443/login)
→ 30 × 401, elapsed 0.46 s (~65 req/s over TLS)
→ Caddy adds no rate limiting either
```

Source review confirms there is no attempt counter, no backoff, no lockout, and no `@fastify/rate-limit` registration on any route — not on `/login`, not on the bearer guard, not on the enrolment route.

### 9.2 FINDING F-3 (SEV-2) — the admin console has no audit trail at all

```
$ journalctl -u pantheon-admin@pantheon --since "20 min ago"
-- No entries --
```

That is after 60 failed logins, ~150 rejected API calls, 4 record creations, 4 deletions, and a WebSocket upgrade attempt. `buildApp` constructs Fastify with `logger: false`, so there is **no access log, no auth-failure log, and no mutation log**. The entire service journal since 2026-08-19 contains six systemd lines and three startup banners — nothing else. Nothing else logs either: there is no separate audit sink.

**Exploit narrative.** Consider a LAN attacker who spends a week probing `http://192.168.1.93:8088`: enumerating routes, testing credential shapes, running a dictionary against `/login`. There is no record that any of it happened. If they eventually succeed — through a stolen token, a reused passphrase, a browser session lifted from a compromised machine — there is also no record of the successful login, no record of which dev machines were added or edited, and no record of terminal sessions opened into the operator's Mac. **The console that can open a shell on the operator's primary development machine produces zero forensic evidence.** Post-incident, there is nothing to review.

This is why I rate it above the rate-limiting gap: rate limiting is prevention that the credential strength largely substitutes for; logging is detection and forensics, for which there is no substitute.

**Severity: SEV-2.** Significant security gap; workaround exists (Caddy's `log` directive is enabled on the LibreChat site and could be added to the admin site for request-level logging, though it cannot see auth outcomes or mutations).
**Suggested fix:** enable the Fastify logger with a redaction allow-list (the Bible already specifies Pino redaction under TM-001/TM-008), log auth outcomes and registry mutations, and add `log` to the admin site in the Caddyfile as a stopgap.

### 9.3 Credential strength — **PASS**, and it materially lowers F-2

Measured on the VM without revealing any value:

| Secret | Length | Character classes present |
|---|---|---|
| `ADMIN_API_TOKEN` | 64 chars | digits + lowercase (64 hex chars = **256 bits**) |
| `PANTHEON_OPERATOR_PASSWORD` | 24 chars | lowercase + uppercase + digits + symbols |
| `PETA_ADMIN_TOKEN` | 48 chars | — |

The admin token meets the Bible's ≥256-bit entropy requirement (TM-001). The operator passphrase is 24 characters across four character classes.

**I want to be explicit rather than alarmist:** at 83 req/s against a 24-character mixed-class passphrase, online brute force is not a realistic attack. F-2 is a defence-in-depth gap, not a live exposure, and I have rated it SEV-3 accordingly rather than inflating it. It matters if the passphrase is ever changed to something weaker, and it matters as the thing that makes an attack *cheap to attempt* and — because of F-3 — *free to attempt undetected*.

### 9.4 Session handling — **PASS**, with two SEV-4 notes

`SessionStore.create()` mints `randomBytes(32).toString("hex")` — a 256-bit id, unguessable. Cookie attributes are `HttpOnly; SameSite=Lax; Path=/; Max-Age=43200` plus `Secure` (since `PANTHEON_SECURE_COOKIES=true`). `SameSite=Lax` blocks cross-site POST CSRF against the config-page and provision forms, which is why the absence of CSRF tokens is not a finding. `POST /login` compares via `timingSafeEqualStr`, which hashes both inputs to fixed length first — genuinely constant-time with no length leak. Logout destroys the server-side session.

- **F-14 (SEV-4):** the session map is unbounded and entries are purged only when that specific id is next accessed, so expired sessions accumulate for the process lifetime. Reaching it requires the passphrase, so it is a hygiene note.
- **F-15 (SEV-4):** `operatorGuard`'s bearer path compares `Buffer.length` before `timingSafeEqual`, so token *length* is observable by timing. The code documents this as an accepted trade-off ("Length is not secret here"). Recorded for completeness; with a 256-bit token the length is not useful to an attacker.

---

## 10. Peta

**From this Mac:** port 3002 is **closed/filtered**. `ss` confirms `127.0.0.1:3002`, and the Docker NAT rule DNATs only for `ip daddr 127.0.0.1`. The Caddyfile deliberately does not proxy Peta ("Peta is deliberately NOT proxied here (bound to 127.0.0.1 in compose — TM-007)"). **PASS.**

**From the VM, unauthenticated:**

| Path | Code | Body |
|---|---|---|
| `/admin` | 404 | `<pre>Cannot GET /admin</pre>` (Express default) |
| `/admin/` | 404 | same |
| `/admin/owner`, `/admin/identities`, `/admin/approvals` | 404 | same |
| `/admin` with `Authorization: Bearer junk` | **401** | — |
| `/v1/tools` | 404 | — |

The admin surface serves nothing without credentials and returns 401 once a credential is presented and rejected. **PASS.** (The 404-without-header / 401-with-bad-header inversion is a quirk of Peta's routing, not a bypass — neither returns admin content.)

**Observation:** `/` and `/health` are unauthenticated and return a service banner — `{"service":"Peta Core","version":"1.2.2","status":"running","endpoints":{…},"oauth":{…}}` and uptime, session counts, socket.io connection counts, and MCP server names/states (`"Mock MCP":"Error"`). Version-and-topology disclosure that would matter if 3002 were ever exposed. Contained today by the loopback bind; flagged in case a future change publishes the port. Not a finding at the current posture.

**Related:** the authenticated `GET /api/mcp-servers` on the control plane returns `500 {"error":"internal_error"}` because Peta has no owner/identities configured yet (skeleton step 2). Fail-closed, no leak — an operational state, not a security finding. The `/admin/config` page handles the same condition gracefully with a rendered banner.

---

## 11. Key custody and the full attack chain

### FINDING F-12 (SEV-3) — "vault custody" is a plaintext file

```
$ ls -la /home/pantheon/.pantheon/keys
drwx------ 2 pantheon pantheon 4096 .
-rw------- 1 pantheon pantheon  419 harness        <- unencrypted private key
-rw-r--r-- 1 pantheon pantheon  106 harness.pub
```

Permissions are correct (dir `0700`, private key `0600`, owned by the service user), and `/opt/pantheon/…/data/control-plane.db` is `0600` as required. The private key never reaches the browser, never appears in the config page (verified: `grep` for `BEGIN … PRIVATE` over the rendered page returns 0), and cannot be forged into a record through the API (§6.2). All of TM-020's stated controls are working as designed.

But `FileKeyCustody` is a directory of plaintext files, not a vault. **Anything that executes as `pantheon` reads the key that opens an interactive shell on the operator's Mac as `karl`.**

**Full chain, stated plainly.** This is what a LAN attacker's best path actually looks like against the current deployment:

1. Read `http://192.168.1.93:8088/help` — unauthenticated, no TLS, no log. Learn the VM address, the key path, the `.env.local` path, and that the console listens on all interfaces. *(F-1, F-9)*
2. Attack `POST http://192.168.1.93:8088/login` at 83 req/s, indefinitely, with no lockout and no record anywhere. *(F-1, F-2, F-3)* — **this step is where the chain breaks today**, because the passphrase is 24 mixed-class characters and the token is 256 bits. The chain is theoretical, not demonstrated.
3. If step 2 ever succeeded, or if a token leaked from a cleartext `:8088` request captured on the wire *(F-1)*: open `wss://…/terminal/Mac-Mini` and get an interactive PTY as `karl` on the operator's primary development machine — the TM-020 RCE surface — with no record that it happened *(F-3)*.
4. Alternatively, from any code execution as `pantheon`: `cat /home/pantheon/.pantheon/keys/harness` and SSH directly, skipping the console entirely *(F-12)*.

The controls that hold this together are the credential strength (§9.3) and the fail-closed guard (§3). The controls that are missing are TLS enforcement, detection, and key encapsulation. **Severity SEV-3** for F-12 specifically — it is the known, accepted `FileKeyCustody` design pending the vault migration, and the filesystem permissions are correct — but it is the reason steps 1–3 matter more than they otherwise would.

### FINDING F-13 (SEV-3) — terminal reattach does not bind the session to the machine

Code-level, in `src/http/routes/terminal.ts`:

```ts
const existing = reconnectId ? deps.terminals.get(reconnectId) : undefined;
const term = existing && !existing.isClosed
  ? existing
  : await openTerminalForMachine(req.params.logicalName, deps);
```

When `?session=<id>` resolves to a live terminal, it is attached **without checking that the terminal belongs to `req.params.logicalName`**. A request to `/terminal/MachineA?session=<id-of-a-MachineB-terminal>` attaches to MachineB's PTY.

Not exploitable today: the route is admin-guarded (verified 401/403 unauthenticated in §3.6), there is a single operator, and there is exactly one dev machine, so there is no second machine to cross into. It is a missing invariant that becomes real the moment a second machine is registered or a second operator identity exists — the point at which the harness stops being single-tenant. **SEV-3**, filed as a latent gap.
**Suggested fix:** verify `term.logicalName === req.params.logicalName` before reattaching; otherwise open a fresh terminal.

---

## 12. Findings table

| # | Severity | Area | Finding | Exploitable today? |
|---|---|---|---|---|
| **F-1** | **SEV-2** | Network posture | Control plane binds `0.0.0.0:8088`; full admin surface reachable from any LAN host over cleartext HTTP, bypassing Caddy's TLS and all four security headers. Contradicts the documented `127.0.0.1` posture. | Yes — as a credential-interception and unmonitored-attack channel. Auth itself still holds. |
| **F-3** | **SEV-2** | Logging / forensics | `logger: false`; zero access, auth-failure and mutation logging. 60 failed logins + ~150 rejected calls + 8 registry writes produced **no journal entries**. No audit trail on a console that can open a shell on the operator's Mac. | Yes — detection and post-incident review are impossible. |
| **F-2** | SEV-3 | Auth hardening | No rate limiting, backoff, lockout or `Retry-After` on `POST /login` or any route; Caddy adds none. 83 req/s direct, 65 req/s via TLS. | Mitigated in practice by a 24-char mixed-class passphrase and a 256-bit token. Defence-in-depth gap. |
| **F-4** | SEV-3 | API contract | Framework-level client errors masked as `500`: missing body, `null` body, malformed JSON, unsupported media type, >1 MB body, prototype-pollution payloads. Contract requires 400/413/415. Bodies are sanitised — no stack traces. | No security impact; all fail closed. Breaks monitoring and client behaviour. |
| **F-5** | SEV-3 | Input validation | No maximum length on `logicalName` or `host`. 10,000-char name and 5,000-char host both accepted with `201`. (`sshKeyHandle` is correctly capped at 128.) | Authenticated availability/robustness issue; renders the Config page and machine picker unusable. |
| **F-6** | SEV-3 | Input validation | `PUT` silently coerces `enabled`: `"true"`, `"banana"`, `1` all return `200` and set `enabled=false`. Contradicts the strict-`port` doctrine stated in `app.ts`. | Fails closed (disables). Silent state change with no log (F-3). |
| **F-9** | SEV-3 | Info disclosure | Public unauthenticated `/help` publishes VM IP, five other internal IPs, the SSH key directory path, the `.env.local` path, the passphrase-reset script path, the DB path, every secret's env-var name, and the note that the console listens "on all interfaces". No secret *values*. | Accelerates any attacker with a foothold; no foothold on its own. |
| **F-12** | SEV-3 | Key custody | `FileKeyCustody` stores the harness private key as an unencrypted file. Permissions correct (`0700`/`0600`); key never reaches the browser or the registry API. Any code execution as `pantheon` yields SSH to the operator's Mac as `karl`. | Known/accepted design pending vault migration. Not remotely reachable. |
| **F-13** | SEV-3 | Terminal gateway | `?session=<id>` reattach does not verify the reconnect id belongs to the requested `:logicalName`. | No — admin-guarded, one operator, one machine. Latent; becomes real at machine #2. |
| **F-7** | SEV-4 | API contract | Array bodies, `text/plain` bodies and mistyped content-types on `PUT` return `200` with an unchanged record instead of a 4xx. | No — silent no-op success. |
| **F-8** | SEV-4 | API contract | `PUT` to an unknown id returns `400` (should be `404`) and reflects the caller-supplied id. Traversal strings are contained (used only as a map key). | No. |
| **F-10** | SEV-4 | Info disclosure | Unauthenticated `/v1/chat/completions` returns Fastify's default 404 naming the method and route — the only unauthenticated 404 on the service. | No. |
| **F-11** | SEV-4 | Headers | No `Cache-Control: no-store` and no `Content-Security-Policy` on admin HTML, which lists the full registry. | No. |
| **F-14** | SEV-4 | Session store | Unbounded in-memory session map; expired entries purged only on access to that id. | No — requires the passphrase. |
| **F-15** | SEV-4 | Auth | Bearer guard compares `Buffer.length` before `timingSafeEqual`, exposing token length by timing. Documented as accepted in-code. | No — 256-bit token. |

**No SEV-1 finding.** No trust-boundary breach, no auth bypass, no ungated write, no key or token exposure, no data loss, no gateway bypass.

**Priority order if only three things get fixed:** F-1 (bind to `172.18.0.1`, one line), F-3 (enable request + auth + mutation logging), F-6 (add `assertEnabled`).

---

## 13. What I attempted and could not break

Stated plainly, because a clean result is only useful if the reader knows what was actually tried.

**Authentication and authorisation — no bypass found.**
- 12 credential shapes (missing, empty, malformed, wrong-case scheme, wrong scheme, wrong value, short value, duplicated header, forged cookie, empty cookie, two proxy-header spoofs). Every one 401 or 403, correctly discriminated.
- 8 HTTP methods on a guarded route, including `TRACE` and `OPTIONS`. All 401 — the hook runs before routing.
- 21 path-normalisation and guard-exemption attacks: trailing slash, double slash, case variation, percent-encoded separators, `..` traversal in four positions, null-byte truncation, semicolon path-parameter smuggling, fragment smuggling, trailing-space, percent-encoded route characters, absolute-URI request line, `Host` override. All 401. The `routeOptions.url ?? req.url` fallback guards unrouted paths rather than exempting them — the failure direction is correct.
- WebSocket upgrade on the TM-020 terminal route, unauthenticated, with a wrong bearer, with a forged cookie, through Caddy, and with a reattach-session parameter. All refused before the gateway; no 101, no SSH attempt.
- Cross-hostname reach: the LibreChat host's SPA catch-all returns 200 for `/harness`, `/admin/config`, `/terminal/Mac-Mini` and `/login`, but serves LibreChat's index in every case (byte-identical, 8077 B, verified by title and marker). No admin content crosses hostnames. `Host`-header routing to the admin site still requires credentials.
- Proxy-header spoofing (`X-Forwarded-For/Host/Proto`, `X-Real-IP`) through Caddy: no effect, the app trusts none of them.
- CRLF injection in the path and response-splitting through the login redirect: no header injection.

**Injection — nothing got through.**
- Shell metacharacters, command substitution, backticks and pipes in `host`: all rejected by grammar.
- `ssh`/`ssh-copy-id` option injection via a leading `-` in `logicalName`, `host` and `user`: all rejected.
- Path traversal in `logicalName`, `sshKeyHandle` and the `:id` path parameter: rejected, or contained as an opaque lookup key that never touches the filesystem.
- Null bytes, newlines and CRLF inside field values: rejected.
- Unicode homoglyph (`Mac‑Mini`) and RTL-override (`‮`) attempts to shadow or spoof the real `Mac-Mini` record: rejected. Duplicate `logicalName` is refused by the uniqueness check — the operator's record cannot be overwritten or shadowed.
- Prototype pollution via `__proto__` and `constructor`: rejected by `secure-json-parse` before the handler; no pollution observed in subsequent requests.
- Stored XSS: field grammars exclude markup, and all three renderers escape all five HTML-significant characters at every interpolation including attribute values.
- SQL injection: not reachable — the repository is parameterised and the API surface never accepts free-form query text.

**Integrity invariants — all held.**
- Could not forge `provisioned: true`. Could not forge `sshKeyHandle`. Could not rebind `logicalName`. Could not overwrite `id` or `createdAt`. `markProvisioned` remains the only writer of provisioning state (TM-020 invariant #4), and `next` is built field-by-field so unknown patch keys are structurally unreachable.
- Could not produce a partial write. Every rejected payload left the record byte-identical.
- Could not extract the SSH private key through any API surface, the config page, an error message or the terminal route.
- Could not extract the admin token or the operator passphrase from any response, including 500s.
- Could not make the enrolment route echo a supplied password into a response body or the journal (sentinel test: 0 matches in both).

**Not attempted, deliberately, and why:**
- **A successful provision or an authenticated terminal session against `Mac-Mini`** — both would place the harness key on, or open a shell on, the operator's live working machine. Forbidden by the brief, and the right call regardless.
- **Any valid `PUT` against `Mac-Mini`** — `updateDevMachine` resets `provisioned` and clears `sshKeyHandle` whenever a connectivity field changes, so a "harmless" edit would have de-provisioned the operator's machine. Only guaranteed-400 shapes were sent to that id.
- **A real dictionary attack on the operator passphrase** — forbidden. The rate-limit probe used literal non-guess strings only.
- **Slowloris, connection exhaustion, or sustained load** — a live availability attack on a system the operator is using. F-2 establishes that nothing would throttle it; demonstrating it would have been vandalism, not testing.
- **Writes to `backend_registry` or `service_endpoint`** — outside the scope the brief authorised. The `displayName` free-text XSS question was answered by reading the renderers instead, which is conclusive.
- **Peta's authenticated admin surface** — probing it needs `PETA_ADMIN_TOKEN` against a gateway mid-configuration; the brief asked only that unauthenticated access be refused, which it is.

---

## 14. Registry attestation

**The registry holds exactly one dev machine.** Verified three ways after all testing completed: via `GET /api/dev-machines`, via a direct read-only `node:sqlite` open of the database file, and by row count across all three tables.

```
$ node -e '…' /opt/pantheon/pantheon-harness/services/control-plane/data/control-plane.db
tables: backend_registry, service_endpoint, dev_machine
  backend_registry: 2 rows
  service_endpoint: 2 rows
  dev_machine: 1 rows

{"id":"7c28eed5-f172-4b17-b77e-9eb1dbee2377","logical_name":"Mac-Mini",
 "host":"192.168.1.192","port":22,"user":"karl","ssh_key_handle":"harness",
 "provisioned":1,"enabled":1,
 "created_at":"2026-08-19T14:26:37.306Z","updated_at":"2026-08-19T15:10:55.163Z"}
```

**`Mac-Mini` — enabled, provisioned, unmodified.** The record is field-for-field identical to the baseline captured before any probe began. `updated_at` is still `2026-08-19T15:10:55.163Z`; had any write touched this row it would carry a 2026-08-20 timestamp. `provisioned` is `1` and `ssh_key_handle` is `harness`, both unchanged.

**Backends and service endpoints are also unchanged** (2 and 2, same ids, endpoints and enabled flags as baseline): `seed-alden-1`/`Alden-1` (enabled), `1e8a30c0…`/`SLM-7900XTX` (disabled), `seed-qdrant`/`Qdrant` (enabled), `seed-bridge`/`Alden Bridge` (enabled).

**Records created and deleted during this probe — all four confirmed gone:**

| id | Why created | Deleted |
|---|---|---|
| `2b382def-fb85-408b-bd95-2ee35cb33e7b` | accidental 201 from the 10,000-char `logicalName` payload (F-5) | `204` |
| `3216813b-efe3-44c1-9e36-7a051edf5da5` | accidental 201 from the 5,000-char `host` payload (F-5) | `204` |
| `55eb8e33-9b66-424f-be9c-a78da0c8f8da` | accidental 201 from the `port: 1e3` payload (§5.3) | `204` |
| `57d688c9-8087-472b-ad9e-9aa8573f4950` | deliberate throwaway `advprobe-tmp` for the PUT and enrolment matrices | `204` |

**No lasting change was made.** No file on the VM was edited. No service was restarted, stopped or reconfigured. No container was touched. No SSH session was opened to `192.168.1.192` — the operator's tmux sessions (Alden, cdf, ios-app, lancache, new-solo, pantheon, solo) were never attached, listed, created or killed, and the harness never connected to that machine during this probe. No repository file was modified except this report. No credential was rotated, printed, logged or transmitted off the VM.

The only residue is a grown SQLite WAL file (`control-plane.db-wal`, 346 KB) from the create/delete churn, which SQLite will checkpoint on its own. The main database file's SHA-256 is unchanged from the pre-probe baseline (`14948fa5e2d8f2d2f9d9f9349a2626f275b36c870d724b183d7c9216d676f20e`). One temp file (`/tmp/adv-big.json`) was created for the body-limit test and removed in the same script.
