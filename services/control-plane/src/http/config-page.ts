/**
 * Server-rendered Configuration page (PROJECT_BIBLE §9 / CC1). Plain template strings — no SPA.
 *
 * COLORBLIND-SAFE (CC1, hard AC): every control/status carries a TEXT LABEL plus a shape/icon
 * token (a glyph + `data-status` + `aria-label`), never color alone. Four states are represented
 * per the §9 contract: Empty (per-section empty-state text), Loading (n/a for a static render but
 * documented), Error (role="alert" banner with icon+label), Success (role="status" confirmation).
 */

import type { Backend, DevMachine, ServiceEndpoint } from "../registry/types.js";

export interface ConfigPageModel {
  readonly backends: readonly Backend[];
  readonly mcpServers: readonly unknown[];
  readonly serviceEndpoints: readonly ServiceEndpoint[];
  /** Claude-CLI SSH targets (ADR-0005, §9 C.6). Optional for backward compatibility. */
  readonly devMachines?: readonly DevMachine[];
  /** Render an error banner (icon + label) when set. */
  readonly error?: string;
  /** Render a success confirmation (icon + label) when set. */
  readonly notice?: string;
}

/** Escape the five HTML-significant characters — fail-closed against markup injection. */
function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Status pill: text label + shape glyph + machine-readable token. NEVER color-only (CC1). */
function statusPill(enabled: boolean): string {
  const label = enabled ? "Enabled" : "Disabled";
  const glyph = enabled ? "[x]" : "[ ]"; // shape token, distinguishable without color
  const token = enabled ? "enabled" : "disabled";
  return `<span class="status" data-status="${token}" role="img" aria-label="${label}"><span class="glyph">${glyph}</span> ${label}</span>`;
}

/** Provisioning pill: text label + shape glyph + token. NEVER color-only (CC1). */
function provisionPill(provisioned: boolean): string {
  const label = provisioned ? "Provisioned" : "Not provisioned";
  const glyph = provisioned ? "[✓]" : "[…]"; // shape token, distinguishable without color
  const token = provisioned ? "provisioned" : "unprovisioned";
  return `<span class="status" data-status="${token}" role="img" aria-label="${label}"><span class="glyph">${glyph}</span> ${label}</span>`;
}

function banner(model: ConfigPageModel): string {
  let out = "";
  if (model.error !== undefined) {
    out += `<div class="banner banner-error" role="alert"><span class="glyph" aria-hidden="true">[!]</span> <strong>Error:</strong> ${esc(
      model.error
    )}</div>`;
  }
  if (model.notice !== undefined) {
    out += `<div class="banner banner-success" role="status"><span class="glyph" aria-hidden="true">[✓]</span> <strong>Success:</strong> ${esc(
      model.notice
    )}</div>`;
  }
  return out;
}

function backendsSection(backends: readonly Backend[]): string {
  const rows =
    backends.length === 0
      ? `<p class="empty-state" data-state="empty">No backends configured yet. Use “Add Backend” to register one.</p>`
      : `<table><thead><tr><th>Display Name</th><th>Kind</th><th>Endpoint</th><th>Status</th><th>Actions</th></tr></thead><tbody>${backends
          .map(
            (b) =>
              `<tr><td>${esc(b.displayName)}</td><td>${esc(b.kind)}</td><td>${esc(b.endpoint)}</td><td>${statusPill(
                b.enabled
              )}</td><td><button type="button" data-action="edit-backend" data-id="${esc(
                b.id
              )}">Edit</button> <button type="button" data-action="remove-backend" data-id="${esc(
                b.id
              )}">Remove</button></td></tr>`
          )
          .join("")}</tbody></table>`;

  return `<section aria-labelledby="h-backends"><h2 id="h-backends">AI Backends</h2>${rows}
  <form method="post" action="/api/backends" data-form="add-backend">
    <label>Display Name <input name="displayName" required></label>
    <label>Kind
      <select name="kind">
        <option value="local_alden1">local_alden1</option>
        <option value="claude_cli">claude_cli</option>
        <option value="future_local_7900xtx">future_local_7900xtx</option>
        <option value="future_cloud">future_cloud</option>
      </select>
    </label>
    <label>Endpoint (host:port) <input name="endpoint" placeholder="192.168.1.89:8080" required></label>
    <label>Enabled <input type="checkbox" name="enabled" checked></label>
    <button type="submit">Add Backend</button>
  </form></section>`;
}

function mcpSection(servers: readonly unknown[]): string {
  const rows =
    servers.length === 0
      ? `<p class="empty-state" data-state="empty">No MCP servers registered. Register one to make it reachable behind Peta.</p>`
      : `<ul>${servers
          .map((s) => {
            const id = (s as { serverId?: unknown }).serverId;
            const name = (s as { serverName?: unknown }).serverName ?? id;
            return `<li>${esc(name)} <button type="button" data-action="remove-mcp" data-id="${esc(
              String(id)
            )}">Remove</button></li>`;
          })
          .join("")}</ul>`;

  return `<section aria-labelledby="h-mcp"><h2 id="h-mcp">MCP Servers</h2>${rows}
  <form method="post" action="/api/mcp-servers" data-form="add-mcp">
    <label>Server ID <input name="serverId" required></label>
    <label>Server Name <input name="serverName" required></label>
    <label>Endpoint (host:port) <input name="endpoint" placeholder="10.100.23.90:9000" required></label>
    <button type="submit">Register MCP Server</button>
  </form></section>`;
}

function serviceEndpointsSection(endpoints: readonly ServiceEndpoint[]): string {
  const rows =
    endpoints.length === 0
      ? `<p class="empty-state" data-state="empty">No service endpoints configured.</p>`
      : `<table><thead><tr><th>Display Name</th><th>Key</th><th>Endpoint</th><th>Status</th><th>Actions</th></tr></thead><tbody>${endpoints
          .map(
            (e) =>
              `<tr><td>${esc(e.displayName)}</td><td>${esc(e.key)}</td><td>${esc(e.endpoint)}</td><td>${statusPill(
                e.enabled
              )}</td><td><button type="button" data-action="edit-endpoint" data-id="${esc(
                e.id
              )}">Edit</button> <button type="button" data-action="remove-endpoint" data-id="${esc(
                e.id
              )}">Remove</button></td></tr>`
          )
          .join("")}</tbody></table>`;

  return `<section aria-labelledby="h-endpoints"><h2 id="h-endpoints">Control-plane Service Endpoints</h2>${rows}
  <form method="post" action="/api/service-endpoints" data-form="add-endpoint">
    <label>Display Name <input name="displayName" required></label>
    <label>Key
      <select name="key">
        <option value="qdrant">qdrant</option>
        <option value="gitea">gitea</option>
        <option value="bridge">bridge</option>
        <option value="obsidian">obsidian</option>
        <option value="peta">peta</option>
        <option value="other">other</option>
      </select>
    </label>
    <label>Endpoint (host:port) <input name="endpoint" placeholder="10.100.23.79:6333" required></label>
    <label>Enabled <input type="checkbox" name="enabled" checked></label>
    <button type="submit">Add Service Endpoint</button>
  </form></section>`;
}

/**
 * Dev Machines section (ADR-0005, §9 C.6). Lists Claude-CLI SSH targets and an Add form.
 * SECURITY (C.5/TM-020): the SSH key is custodied in the vault and installed by the provisioning
 * flow (sub-task b) — this page never accepts or displays the key handle or any raw key material.
 * Only the *provisioned* status is surfaced so the operator knows which machines still need it.
 */
/**
 * One-time enrollment form (ADR-0005, TM-020). Registering a machine only records where it is; it
 * becomes usable once the harness PUBLIC key is installed on it, which needs one authenticated
 * connection. Collecting that password here keeps setup inside the harness — the operator should
 * never have to run a command on their own machine to finish a job the UI started.
 *
 * The field is `type="password"` + `autocomplete="off"` so it is neither displayed nor offered back
 * by the browser later, and the server uses it for that single connection without storing or
 * logging it (see `devmachine/enrollment.ts`). Shown only while a machine is unprovisioned.
 */
function provisionForm(m: DevMachine): string {
  if (m.provisioned) return "";
  return ` <form method="post" action="/api/dev-machines/${esc(m.id)}/provision" data-form="provision-devmachine">
      <label>Machine password <input type="password" name="password" autocomplete="off" required
        aria-describedby="provision-note-${esc(m.id)}"></label>
      <button type="submit">Provision</button>
      <span class="muted" id="provision-note-${esc(m.id)}">Used once to install the harness key on
        ${esc(m.logicalName)}. Not stored, not logged. Every later connection is key-only.</span>
    </form>`;
}

function devMachinesSection(machines: readonly DevMachine[]): string {
  const rows =
    machines.length === 0
      ? `<p class="empty-state" data-state="empty">No dev machines configured. Add one to use it as a Claude-CLI SSH terminal target.</p>`
      : `<table><thead><tr><th>Logical Name</th><th>Host</th><th>Port</th><th>User</th><th>Provisioning</th><th>Status</th><th>Actions</th></tr></thead><tbody>${machines
          .map(
            (m) =>
              `<tr><td>${esc(m.logicalName)}</td><td>${esc(m.host)}</td><td>${esc(m.port)}</td><td>${esc(
                m.user
              )}</td><td>${provisionPill(m.provisioned)}</td><td>${statusPill(
                m.enabled
              )}</td><td><button type="button" data-action="edit-devmachine" data-id="${esc(
                m.id
              )}">Edit</button> <button type="button" data-action="remove-devmachine" data-id="${esc(
                m.id
              )}">Remove</button>${provisionForm(m)}</td></tr>`
          )
          .join("")}</tbody></table>`;

  return `<section aria-labelledby="h-devmachines"><h2 id="h-devmachines">Dev Machines (Claude CLI)</h2>${rows}
  <form method="post" action="/api/dev-machines" data-form="add-devmachine">
    <label>Logical Name <input name="logicalName" placeholder="mac-studio" required></label>
    <label>Host (IP/hostname) <input name="host" placeholder="192.168.1.192" required></label>
    <label>Port <input name="port" type="number" value="22" min="1" max="65535"></label>
    <label>User <input name="user" placeholder="karl" required></label>
    <label>Enabled <input type="checkbox" name="enabled" checked></label>
    <button type="submit">Add Dev Machine</button>
  </form>
  <p class="empty-state">SSH key is installed by the provisioning step and held in vault custody — never entered or shown here.</p></section>`;
}

export function renderConfigPage(model: ConfigPageModel): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pantheon Harness — Configuration</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 1.5rem; }
  section { border: 1px solid #888; border-radius: 6px; padding: 1rem; margin-bottom: 1.25rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid #aaa; padding: 0.35rem 0.5rem; text-align: left; }
  .status .glyph { font-family: monospace; }
  .banner { border: 2px solid #333; padding: 0.6rem; margin-bottom: 1rem; border-radius: 4px; }
  .empty-state { font-style: italic; }
  label { display: inline-block; margin-right: 1rem; }
  form { margin-top: 0.75rem; }
</style>
</head>
<body>
<h1>Pantheon Harness — Configuration / Service Registry</h1>
<p><a href="/harness">&larr; Harness</a> &middot; <a href="/help">Help — user guide</a></p>
${banner(model)}
${backendsSection(model.backends)}
${mcpSection(model.mcpServers)}
${serviceEndpointsSection(model.serviceEndpoints)}
${devMachinesSection(model.devMachines ?? [])}
</body>
</html>`;
}
