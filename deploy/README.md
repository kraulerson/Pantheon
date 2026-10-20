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

## Source of truth: GitHub (ruling 2026-10-17)

For Pantheon, **GitHub is the master**: `https://github.com/kraulerson/Pantheon.git`. Gitea stays the
master only for the Alden projects.

- **VM 1093:** the deploy checkout at `/opt/pantheon/pantheon-harness` pulls from GitHub, so a
  change must be uploaded to GitHub before the VM can deploy it.
- **Uploads:** they go to the GitHub remote (`origin`) only.
- **Gitea:** the Gitea copy (`gitea.ferrumcorde.com/kraulerson/Pantheon`) is being archived
  read-only by the homelab side. A working clone may still list it as a second remote. Leave that
  remote in place unless Karl asks; `git fetch --all` will warn about it once it is archived.

To check the VM's checkout before a deploy:

```bash
git -C /opt/pantheon/pantheon-harness remote get-url origin   # expect https://github.com/kraulerson/Pantheon.git
git -C /opt/pantheon/pantheon-harness pull --ff-only
```

## Maestro Console settings file (2026-10-17)

The Console (`/harness/console`, Feature 15) reads one JSON settings file when the admin service
starts.

- **Where:** the path is set by `PANTHEON_CONSOLE_SETTINGS` in `services/control-plane/.env.local`.
  The shipped `.env.local.example` line is empty. **Unset or empty** means `console-settings.json` in
  the same folder as `PANTHEON_DB`. With the install script's `PANTHEON_DB`
  (`services/control-plane/data/control-plane.db`), that is
  `/opt/pantheon/pantheon-harness/services/control-plane/data/console-settings.json` on VM 1093.
- **Missing file:** the defaults apply (5 s poll, 90-day cards, the seven standard areas, no project
  styling). Nothing fails.
- **Contents:** the schema and an example are in the user guide (§4 "The console settings file") and
  spec §7. The file holds no secret, but it must be readable by the service user.
- **When it is read:** once, at startup, so restart the admin service after any edit.
- **A refused file** disables the Console module only. The page shows a banner naming the bad entry,
  and the service log gets `console.poller_not_started` with the entry name, never the value.
  Terminals, approvals and the rest of the harness keep running.
- **Data:** the Console's two tables (`console_session`, `console_card`) are created in the same
  SQLite file as the registry on first start (additive, no migration). Only masked card faces are
  stored; full text is read from the machine on demand.
- **Load:** the poller sends each ready machine one read-only probe per poll (4 s timeout, at most
  one in flight per machine). When a transcript has more to read than one probe carries, it sends up
  to 3 catch-up probes in the same poll; an oversize retry counts as one of them. That is at most 4
  SSH dials per machine per poll, typically 1. It starts only after the service is listening and stops
  before the database closes on shutdown.

**Which entry point runs.** The console is wired only in `dist/server.js`.
- The live VM unit `pantheon-admin@pantheon` carries a drop-in that overrides `ExecStart` to
  `/usr/bin/node dist/server.js`. This was verified read-only on 2026-10-17.
- The repo's `deploy/systemd/pantheon-admin.service` still names `dist/server-admin.js`, from the
  template written before the two-service split. That file has no source, so a fresh install from
  the template would never start the console.
- Before any deploy, confirm the unit and its drop-in:

```bash
systemctl cat pantheon-admin@pantheon   # expect a drop-in with ExecStart=/usr/bin/node dist/server.js
```

After a deploy, check the build stamp (below), then open `/harness/console` signed in. A machine
shows "… no data yet" until its first poll finishes, then its sessions.

## Maestro Console F2: deploy notes (2026-10-20)

F2 lets the Console type into sessions, start sessions and open a machine shell. It adds one key to
the settings file, one table to the database and two machine prerequisites.

**The `machines` key.** A machine with no entry has no shell drawer and no New Session flow
(the page says *no projects root configured*). Each key is a registered machine's logical name;
`projectsRoot` is an absolute path. The two roots in use:

| Machine | `projectsRoot` |
|---|---|
| Mac-Mini | `/Users/karl/Documents/Claude Projects` |
| Linux-Dev | `/development/Claude Projects` |

```json
{
  "machines": {
    "Mac-Mini":  { "projectsRoot": "/Users/karl/Documents/Claude Projects" },
    "Linux-Dev": { "projectsRoot": "/development/Claude Projects" }
  }
}
```

Add this beside the existing keys in the same settings file (it is read once at start, so restart the
admin service afterwards). A root that is not an absolute path, is longer than 512 bytes,
contains a single quote, a `#`, a control character, a lone surrogate, a bidirectional control or a `..`
segment is refused by rule and disables the Console module only, with a banner naming the entry. A space
in the path is allowed, and so is a double quote.

**The submit log.** The first F2 start creates `console_submit_log` in the same SQLite file (additive,
no migration). It is **append-only** (two triggers abort every UPDATE and DELETE) and **kept
forever**: it holds the write-ahead and result rows of every send, new session and shell open, with a
masked copy of each reply. It is backed up with the database. Back the database file up before the first
F2 start, as for any deploy.

**tmux locale (ruling T8-6).** A tmux server that the console's create script starts cold, over a
non-login SSH command, has no locale variables, so shells inside it run without a locale until the
server is restarted. Avoid it by starting tmux from a login shell on the machine first (open a
terminal on the machine and run `tmux`, or attach to an existing session), so the server already
exists when the console creates a session in it.

**Linux-Dev prerequisites to verify at deploy** (not yet checked on that machine):
- **tmux 3.2 or later.** The create script passes `tmux new-session -e` so `claude` resolves on a
  running server. Check with `tmux -V` on the machine.
- **`claude` on `$HOME/.local/bin`.** The create script prepends that directory to `PATH` and fails
  with the labelled record `claude not found` when it is missing. Check with `ls "$HOME/.local/bin/claude"`
  as the login user the harness connects as.

Also check at deploy: a first live Submit against a throwaway session on each machine, and that the
6 s Submit budget and the 0.5 s settle hold on a machine that is waking up.

## Which build is live?

`curl -sI https://pantheon.ferrumcorde.com/harness/assets/harness.css | grep -i x-pantheon-build`
answers it, and the harness header shows the same `build <id>` stamp. Asset URLs carry `?b=<id>`, so
a browser fetches fresh CSS/JS after every deploy; console HTML is `no-store`. Set `PANTHEON_BUILD`
in `services/control-plane/.env.local` (e.g. the commit) to make the stamp a commit hash instead of
a timestamp.
