# Pantheon Harness — deploy directory

Deployment artifacts for the walking skeleton (D-ENC: **Debian VM on Proxmox**).
Step-by-step usage lives in `docs/skeleton-steps/step-01-vm-provision-and-install.md`
and `step-02-peta-hardened-deploy.md` — this README is the map, not the runbook.

## What runs where (deliberate split)

| Layer | Runs as | Defined in |
|---|---|---|
| Caddy, LibreChat (+Mongo/Meilisearch), Peta-core (+Postgres) | Docker Compose | `docker-compose.yml` |
| Control-plane **admin** + **Facade** (ADR-0007), obsidian-mcp | systemd units (native Node build) | `systemd/*.service` |

Rationale: our own services have no Dockerfiles and `scripts/install-debian.sh` already
builds them natively; ADR-0007 explicitly allows "systemd units or compose." The
third-party stack is compose-managed for pinning and restart policy.

## Files

- `docker-compose.yml` — the third-party stack. Hardening baked in: Peta + Postgres
  bound to **127.0.0.1 only** (TM-007: `/admin`/`GET_OWNER` structurally unreachable
  from LAN; Peta is never proxied by Caddy); no `docker.sock` mounts; **no LibreChat
  RAG API** (CVE-2026-4276); image tags pinned, `VERIFY` markers where the exact tag
  must be confirmed at deploy time.
- `Caddyfile` — two LAN sites (`pantheon.lan` → LibreChat, `admin.pantheon.lan` →
  admin service on the host), `tls internal`, §11 security headers.
- `.env.example` — compose variables. Copy to `.env` (gitignored), fill with
  `openssl rand -hex 32` secrets.
- `librechat.yaml` — LibreChat custom endpoints: **"Pantheon"** (identity route → the Facade,
  live when M2 lands) and **"Basic LLM - …"** (one raw-brain endpoint per LAN llama.cpp server —
  no persona, no memory, no tools; ruling 2026-08-26 "both modes"). The 27B brain's key comes from
  `.env` (`LLM_MINI_API_KEY`). The operator switches modes with LibreChat's endpoint picker.
  Historically: LibreChat custom endpoint pointed at the Facade
  (`host.docker.internal:8089`). The identity-header wiring is the decision-B spike's
  open question — see `docs/skeleton-steps/step-08-librechat-spike.md`.
- `systemd/` — unit templates for admin/Facade/obsidian-mcp. Instantiated as
  `pantheon-admin@<user>.service` (the `%i` is the service user). Paths assume the repo
  at `/opt/pantheon/pantheon-harness`; adjust if different.

## Digest pinning (do after first successful pull)

```bash
docker compose pull
docker images --digests   # copy each RepoDigest
# replace image tags in docker-compose.yml with name@sha256:... and commit
```

## TLS on the LAN

`tls internal` makes Caddy mint certificates from its own local CA. Trust it once per
browser/device: fetch the root cert from the caddy container
(`docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt .`) and install it
in the OS/browser trust store. Hostnames `pantheon.lan` / `admin.pantheon.lan` need LAN
DNS entries (pfSense host overrides) or `/etc/hosts` lines on each client.

## The M2 network test (must pass before anything else trusts this host)

From a NON-host machine on the LAN/tailnet:

```bash
curl -s -o /dev/null -w '%{http_code}' http://<vm-ip>:3002/admin -X POST -d '{}'  # expect: timeout/refused, NOT 200/401
nmap -Pn -p 3002,5433,3080,27017,7700 <vm-ip>                                    # expect: all closed/filtered
```

Public reachability is a defect, not a recoverable state (Bible §11).

## Household hostname — `pantheon.ferrumcorde.com` (added 2026-08-19)

The chat UI is published to the household under `pantheon.ferrumcorde.com` via the homelab's
**service-intake platform** (`http://10.100.23.60:8000`, LXC 1060 on node `proxmox-2`). The
intake ran its 12-step pipeline end-to-end: household Caddy (CT 1052, `10.100.23.52`) vhost →
both Pi-holes (`192.168.1.41` / `.42`) → Homepage tile (`10.100.23.51`, category *Alden AI
Stack*). **Do not hand-edit the household Caddyfile** — the intake owns it (it keeps timestamped
backups and re-validates); use its edit mode to change the backend.

Request path: browser → household Caddy `10.100.23.52:443` (public-trusted wildcard cert,
Let's Encrypt via Cloudflare DNS-01) → `https://192.168.1.93:443` (this host's Caddy, internal
CA, `tls_insecure_skip_verify` on the hop) → `librechat:3080`.

**Exposure posture is unchanged: internal only.** The A record lives solely in the two Pi-holes;
`dig @1.1.1.1 pantheon.ferrumcorde.com` returns nothing. DNS-01 issuance publishes no per-host
record, and the wildcard cert already existed. Same posture as `alden.ferrumcorde.com`
(ruling 2026-08-18) — no public DNS, no tunnel, no port-forward.

Two things in `Caddyfile` exist **only** to make that hop work — do not "clean them up":

1. `default_sni pantheon.ferrumcorde.com` (global) — the edge proxy dials this host by IP, so
   its TLS ClientHello carries no SNI; with no default the handshake fails outright.
2. `192.168.1.93` listed as a third address on the chat site — the edge proxy's request arrives
   with the **IP as Host/`:authority`**, which matches no named site, and Caddy answers an
   unmatched site with an empty `200` and no access-log line. That failure is silent: the
   route "works" (HTTP 200) while serving a zero-byte body. Verified both ways on 2026-08-19.

If the VM's IP ever changes, three places move together: this Caddyfile line, the intake's
edit-mode backend, and the Homepage tile's IP label (the intake syncs the label itself).

## Admin console entrance — `pantheon-admin.ferrumcorde.com` (added 2026-08-19)

Registered through the same service-intake platform, but pointed at **port 8443**, not a second
hostname on 443. Reason: the household edge proxy rewrites `Host` to the backend address (its
requests arrive here as `Host: 192.168.1.93:443`, with the real name only in `X-Forwarded-Host`),
so two household names are indistinguishable on one port. The admin site therefore listens on
`admin.pantheon.lan` **and** `192.168.1.93:8443`, and 8443 is published in `docker-compose.yml`.
Matching on `X-Forwarded-Host` was rejected — any LAN client could forge it.

The chat UI links to it through `HELP_AND_FAQ_URL` (`.env`): LibreChat has no supported way to add
a custom item to the profile menu, so the one configurable item ("Help & FAQ") is repointed here.
If that menu entry ever stops working after a LibreChat upgrade, check that variable first.

Console posture is unchanged: fail-closed 401 without the operator passphrase, `X-Frame-Options:
DENY`, and no public DNS record.

## The harness under the chat address (2026-08-27)

`Caddyfile` path-splits the chat site: `/harness/*` → the admin service with `X-Forwarded-Prefix:
/harness` (the service builds every URL from it); everything else → LibreChat. **After `git pull`
changes the Caddyfile, recreate the container: `docker compose up -d --force-recreate caddy`.** The
Caddyfile is bind-mounted as a single FILE, and git replaces files by rename, so the running
container still sees the OLD inode — `caddy reload` then re-reads the old text and reports success
(bit us 2026-08-27: the split silently stayed off until the recreate). A `reload` is only enough
when the file was edited in place. Either way it — a reload closes live terminal WebSockets, so do it in a quiet moment. Two
`.env` values change with it (`CUSTOM_FOOTER`, `HELP_AND_FAQ_URL` → `/harness/help`) → `docker compose
up -d librechat` to apply. The admin service needs `PANTHEON_CHAT_URL` in its `.env.local` for the
Chat tab on the admin site. The admin site (`:8443`) is a root mount and needs nothing else.

## Which build is live?

`curl -sI https://pantheon.ferrumcorde.com/harness/assets/harness.css | grep -i x-pantheon-build`
answers it, and the harness header shows the same `build <id>` stamp. Asset URLs carry `?b=<id>`, so
a browser fetches fresh CSS/JS after every deploy; console HTML is `no-store`. Set `PANTHEON_BUILD`
in `services/control-plane/.env.local` (e.g. the commit) to make the stamp a commit hash instead of
a timestamp.
