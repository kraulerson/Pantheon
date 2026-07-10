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
- `librechat.yaml` — LibreChat custom endpoint pointed at the Facade
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
