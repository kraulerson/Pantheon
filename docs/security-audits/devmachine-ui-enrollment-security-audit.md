# Security Audit — DevMachine UI Enrollment (password bootstrap from the browser)

**Feature:** `devmachine-ui-enrollment` — set a dev machine up entirely from the Configuration
page: the operator supplies the target machine's password in the browser, the control-plane
installs the harness **public** key over one ssh2 connection, verifies a key-only login, and only
then records `provisioned`.
**Date:** 2026-08-19
**Persona:** Senior Security Engineer (Phase 2.4 — hunt concrete exploits, not checkboxes).
**Why it exists:** provisioning previously required `ssh-copy-id`, which prompts on a TTY, so the
operator had to run a command on their own machine to finish a job the UI started. That is the
hole this closes — and it does so by moving a **high-value credential** (the target machine's login
password) onto a request path, which is exactly why this audit matters.
**Scope refs:** PROJECT_BIBLE §5 (DevMachine), §7 (custody #14b), §8 (TM-008 sanitized errors),
ADR-0005, TM-020.
**Components:** `src/devmachine/enrollment.ts`, `src/devmachine/enrollment-ssh.ts`,
`src/http/routes/enrollment.ts`, `src/http/config-page.ts` (`provisionForm`), `src/server.ts` wiring.

## Threats considered & concrete exploit attempts

| # | Threat (concrete exploit) | Control | Verdict |
|---|---|---|---|
| 1 | **The machine password is persisted.** It reaches the registry DB, custody dir, or a temp file, and survives the request. | The password exists only as a request-scoped string: route → `enrollMachine` → `ssh2.connect({password})`. Nothing writes it anywhere — no DB column, no file, no env. `provisionAndRecord` stores only `provisioned` + the key handle. | **PASS** |
| 2 | **The password is logged.** Fastify or our code writes the body to a log that later lands in a bundle or a screen-share. | The app is built `Fastify({ logger: false })`, and no code logs `req.body` anywhere (grep-verified). The URL carries no secret (`/api/dev-machines/:id/provision`). | **PASS** |
| 3 | **The password comes back out in a response.** A success body, an error body, or a redirect echoes what was typed. | Success → 303 to `/admin/config` (form) or the machine record (JSON), neither of which contains the field. Errors are replaced, never forwarded: `EnrollmentError` messages are written by us, and any other throw becomes `internal_error`. ssh2's own text is deliberately swallowed at both connect sites because it can quote the credential it was handed. | **PASS** (tests assert the password appears in no response body, including the "unexpected explosion" case) |
| 4 | **The password lands in the target's process list.** Passing it via a remote command (`echo $PASS`, `sshpass`) exposes it to every user on the target box. | It is only ever an ssh2 auth parameter. The remote command is built solely from the public key; a test asserts the password appears in no remote command. | **PASS** |
| 5 | **Command injection through the public key.** A crafted key value (`'; rm -rf ~; echo '`) breaks out of the single-quoted remote install command. | The key is matched against a strict OpenSSH grammar (`PUBLIC_KEY_RE`) that forbids quotes, backslashes and newlines, **before any connection is made**; a non-conforming key aborts enrollment. | **PASS** (test: malicious key rejected, zero connections attempted) |
| 6 | **The private key leaves custody.** The install path ships the private half to the target. | Only `resolvePublicKey` feeds the remote command. The private key is read solely for the verification connection and handed to ssh2 in-process. Test asserts no remote command contains the private PEM. | **PASS** (TM-020 intact) |
| 7 | **A machine is marked provisioned when key auth does not actually work.** The append succeeds but `authorized_keys` is ignored (wrong perms, wrong user, SELinux), leaving a row that lies. | Enrollment ends with a **key-only reconnect**; if that fails it throws, and `provisionAndRecord` never reaches `markProvisioned`. | **PASS** (tests: verification failure → error, row stays unprovisioned) |
| 8 | **Unauthenticated enrollment.** Anyone on the LAN posts to the route and makes the harness dial a machine with a guessed password. | The route sits behind the same admin guard as every non-public route (session cookie or bearer). Test asserts 401 with no enrollment attempted. | **PASS** (fail closed) |
| 9 | **CSRF.** A page on another origin posts the form using the operator's session cookie. | The session cookie is `SameSite=Lax`, which suppresses cookie-bearing cross-site POSTs; the bearer path requires a header an attacker page cannot set cross-origin. No CSRF token exists on any Config-page form — pre-existing, unchanged by this feature. | **PASS** for this feature; token-per-form remains a general hardening item |
| 10 | **Empty/absent password degrades to another auth method.** An empty string is passed to ssh2, which then tries agent/none auth and "succeeds" without proving anything. | Refused in two places: the route rejects a missing/empty password (400, nothing dialed) and `enrollMachine` refuses it independently. | **PASS** (both covered by tests) |
| 11 | **Host impersonation harvests the password.** A host answering on the target's IP presents any key, the harness connects and hands over the operator's machine password. | **NOT MITIGATED.** ssh2 is called with no `hostVerifier` and the harness keeps no known_hosts — trust-on-sight, inherited from the existing terminal path. Limited for a key-only terminal; materially worse here because the first connection carries a password. | **FINDING — BUGS #17 (SEV-3, Open)** |

## Findings

**#17 — No SSH host-key verification (SEV-3, deferred with the operator's knowledge).**
Not introduced by this feature (`connection.ts` has always connected this way), but this feature
raises its impact from "session hijack on a trusted LAN" to "credential disclosure". Documented
inline in `enrollment-ssh.ts` so the pattern is not copied blindly. Fix: capture the host key at
first enrollment, store it against the machine row, verify on every later connection, fail closed
on mismatch. Should be closed before anything on this path is reachable from outside the LAN.

## Residual notes (non-blocking)

- **Password lifetime in memory.** JavaScript strings are immutable and cannot be zeroed, so the
  value persists until GC. Unavoidable in this runtime; the exposure window is a single request in
  a single-operator service.
- **Repeated attempts.** The route does not rate-limit, so it can be used to try passwords against
  the *target* machine. The target's own SSH throttling is the control; nothing about the harness's
  secrets is exposed by it. Worth revisiting if this surface ever serves more than one operator.
- **The CLI path is unchanged** and remains the fallback when the web UI itself is broken.

## Conclusion

No exploitable findings **introduced** by this feature: the password is request-scoped, never
persisted, logged, echoed, or placed on a remote command line; the public key is injection-proofed
before use; the private key stays in custody; and `provisioned` is claimed only after key-only login
is proven. One pre-existing gap (**#17**, host-key verification) is raised in severity by this work,
recorded, and deferred deliberately rather than silently. **Cleared to proceed.**
