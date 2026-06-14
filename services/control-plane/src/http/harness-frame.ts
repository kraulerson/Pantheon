/**
 * Server-rendered harness frame (Task #16e, PROJECT_BIBLE §9 C.1/C.6, ADR-0005 — amends ADR-0001).
 *
 * The single entry point behind the #9 auth gate that hosts BOTH UI modalities: LibreChat chat tabs
 * and xterm.js terminal tabs. The New Session popup (AI SYSTEM × IDENTITY) routes a
 * "Claude CLI → <dev machine>" selection to a terminal tab, addressed by the machine's logicalName
 * (#14a — the IP can change without breaking the route). Only provisioned + enabled machines are
 * offered as live terminals; others are shown with a text reason. Colorblind-safe labels (CC1).
 */

import type { DevMachine } from "../registry/types.js";

export interface HarnessFrameModel {
  readonly devMachines: readonly DevMachine[];
  /** LibreChat URL hosted as the chat modality (optional until LibreChat is deployed). */
  readonly chatUrl?: string;
}

function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function devMachinePicker(machines: readonly DevMachine[]): string {
  if (machines.length === 0) {
    return `<p class="empty-state" data-state="empty">No dev machines configured. Add one in <a href="/admin/config">Configuration</a>.</p>`;
  }
  const items = machines
    .map((m) => {
      const ready = m.provisioned && m.enabled;
      if (ready) {
        return `<li><button type="button" data-open-terminal="${esc(m.logicalName)}" data-action="open-terminal">Claude CLI → ${esc(
          m.logicalName
        )}</button> <span class="glyph" aria-hidden="true">[✓]</span></li>`;
      }
      const reason = !m.enabled ? "disabled" : "not provisioned";
      return `<li><span data-state="unavailable">Claude CLI → ${esc(m.logicalName)}</span> — <em>${esc(
        reason
      )}</em> <span class="glyph" aria-hidden="true">[…]</span></li>`;
    })
    .join("");
  return `<ul class="devmachine-list">${items}</ul>`;
}

export function renderHarnessFrame(model: HarnessFrameModel): string {
  const chat =
    model.chatUrl !== undefined
      ? `<iframe class="chat-frame" title="Chat (LibreChat)" src="${esc(model.chatUrl)}"></iframe>`
      : `<p class="empty-state" data-state="empty">Chat (LibreChat) not configured yet.</p>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pantheon Harness</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; }
  header { padding: .5rem 1rem; border-bottom: 1px solid #888; }
  .tabs { display: flex; gap: .5rem; padding: .5rem 1rem; border-bottom: 1px solid #ccc; }
  .glyph { font-family: monospace; }
  dialog { border: 1px solid #888; border-radius: 6px; }
  .chat-frame { width: 100%; height: 70vh; border: 0; }
</style>
</head>
<body>
<header><strong>Pantheon Harness</strong> — chat &amp; terminal</header>

<!-- Tab bar hosts both modalities (chat tabs + terminal tabs) -->
<nav class="tabs" role="tablist" aria-label="Open sessions">
  <button type="button" role="tab" aria-selected="true" data-tab="chat">Chat</button>
  <button type="button" role="tab" aria-selected="false" data-tab="new" data-action="new-session">+ New Session</button>
</nav>

<main>
  <section aria-labelledby="h-chat" data-tab-panel="chat"><h2 id="h-chat">Chat</h2>${chat}</section>
</main>

<!-- New Session popup: AI SYSTEM × IDENTITY (§9 C.1), plus Claude CLI → dev machine routing (C.6) -->
<dialog id="new-session" aria-labelledby="h-new">
  <form method="dialog">
    <h2 id="h-new">New Session</h2>
    <label>AI System
      <select name="aiSystem" data-field="ai-system">
        <option value="local_alden1">Alden-1 (chat)</option>
        <option value="claude_cli">Claude CLI (terminal)</option>
      </select>
    </label>
    <label>Identity <input name="identity" data-field="identity" placeholder="persona" required></label>
    <fieldset>
      <legend>Claude CLI → dev machine</legend>
      ${devMachinePicker(model.devMachines)}
    </fieldset>
    <menu>
      <button type="submit">Start</button>
    </menu>
  </form>
</dialog>

<script>
(function () {
  var dlg = document.getElementById("new-session");
  document.querySelectorAll('[data-action="new-session"]').forEach(function (b) {
    b.addEventListener("click", function () { if (dlg && dlg.showModal) dlg.showModal(); });
  });
  document.querySelectorAll('[data-open-terminal]').forEach(function (b) {
    b.addEventListener("click", function () {
      var name = b.getAttribute("data-open-terminal");
      // Route a "Claude CLI -> machine" selection to a terminal tab (by logicalName, #14a).
      window.open("/harness/terminal/" + encodeURIComponent(name), "_blank");
    });
  });
})();
</script>
</body>
</html>`;
}
