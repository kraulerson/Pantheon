/**
 * Harness UI routes (Task #16d/e, ADR-0005 §9 C.1/C.6; tmux-aware launcher M1 task 1).
 *
 * Serves the harness frame, the xterm.js terminal-tab pages, the xterm.js static assets, and the
 * live tmux session list the launch bar fetches. The frame/terminal/tmux routes sit behind the
 * #9/admin guard (the operator authenticates once). The `/assets/*` files are PUBLIC (a browser
 * `<script>`/`<link>` can't send an auth header, and xterm is a public library) — they are added to
 * the app's PUBLIC_PATHS. The terminal page only opens a WebSocket to the broker; the SSH key never
 * reaches the browser (TM-020/#14b).
 *
 * `GET /harness/tmux/:logicalName` → JSON `{ machine, state, … }`. Every outcome is a LABELED state
 * (CC1): `ok` (200, with `sessions`), `unknown_machine` (404), `not_connectable` (409 — disabled /
 * unprovisioned, resolved by the SAME fail-closed rule the terminal uses, so it never dials),
 * `unreachable` / `tmux_missing` / `failed` (502), `unavailable` (503 — no SSH lister wired).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import { renderHarnessFrame } from "../harness-frame.js";
import { renderTerminalTab, type TerminalTabModel } from "../terminal-tab.js";
import type { DevMachine } from "../../registry/types.js";
import { resolveConnectableMachine, TerminalError } from "../../devmachine/terminal-gateway.js";
import type { TmuxListResult, TmuxLister } from "../../devmachine/tmux.js";
import { requestBase } from "../base-path.js";
import { HARNESS_THEME_CSS, THEME_ASSET_PATH } from "../theme.js";

export type { TmuxLister } from "../../devmachine/tmux.js";

/** Only a registry-shaped name is ever echoed back (audit 2026-08-25: no reflective echo of raw input). */
const ECHOABLE_NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

const nodeRequire = createRequire(import.meta.url);
// Read once at startup. xterm ships a UMD bundle + css we serve from our own origin (offline-safe).
const XTERM_JS = readFileSync(nodeRequire.resolve("@xterm/xterm/lib/xterm.js"), "utf8");
const XTERM_CSS = readFileSync(nodeRequire.resolve("@xterm/xterm/css/xterm.css"), "utf8");
// Fit addon (UMD, global `FitAddon`): sizes the terminal grid to its container — without it xterm
// stays at its 80×24 default however big the tab is (operator report 2026-08-27).
const XTERM_FIT_JS = readFileSync(nodeRequire.resolve("@xterm/addon-fit/lib/addon-fit.js"), "utf8");

/** Public asset paths (added to the app's guard exemption set). */
export const HARNESS_ASSET_PATHS: readonly string[] = ["/assets/xterm.js", "/assets/xterm.css", "/assets/xterm-addon-fit.js", THEME_ASSET_PATH];

export interface HarnessRoutesDeps {
  readonly registry: {
    listDevMachines(): DevMachine[];
    getDevMachineByLogicalName(logicalName: string): DevMachine | undefined;
  };
  /** Whether operator login is enabled (controls the Log out control in the frame). */
  readonly loginEnabled: boolean;
  /** Omit on a server with no SSH custody wired — the tmux route then answers 503 `unavailable`. */
  readonly tmux?: TmuxLister;
  /** The chat page's address for the Chat tab on the root mount (cross-site → a link, never an iframe). */
  readonly chatUrl?: string;
}

export function registerHarnessRoutes(app: FastifyInstance, deps: HarnessRoutesDeps): void {
  // ---- Static xterm assets (PUBLIC) ----
  app.get("/assets/xterm.js", async (_req, reply) => {
    reply.type("application/javascript").send(XTERM_JS);
  });
  app.get("/assets/xterm.css", async (_req, reply) => {
    reply.type("text/css").send(XTERM_CSS);
  });
  app.get("/assets/xterm-addon-fit.js", async (_req, reply) => {
    reply.type("application/javascript").send(XTERM_FIT_JS);
  });
  // Shared LibreChat-matched stylesheet + tokens (ruling 2026-08-27). Public like the xterm assets.
  app.get(THEME_ASSET_PATH, async (_req, reply) => {
    reply.type("text/css").send(HARNESS_THEME_CSS);
  });

  // ---- Harness frame (guarded) ----
  app.get("/harness", async (req, reply) => {
    reply.type("text/html").send(renderHarnessFrame({ devMachines: deps.registry.listDevMachines(), loginEnabled: deps.loginEnabled, base: requestBase(req), ...(deps.chatUrl !== undefined ? { chatUrl: deps.chatUrl } : {}) }));
  });

  // ---- Live tmux session list for a machine (guarded; JSON; labeled states) ----
  app.get<{ Params: { logicalName: string } }>("/harness/tmux/:logicalName", async (req, reply) => {
    const raw = req.params.logicalName;
    const machine = ECHOABLE_NAME_RE.test(raw) ? raw : "(invalid name)";
    if (!deps.tmux) {
      reply.code(503);
      return { machine, state: "unavailable", message: "tmux session listing is not configured on this server" };
    }
    if (!deps.registry.getDevMachineByLogicalName(raw)) {
      reply.code(404);
      return { machine, state: "unknown_machine", message: "no dev machine with that name" };
    }
    let connectable: ReturnType<typeof resolveConnectableMachine>;
    try {
      connectable = resolveConnectableMachine(raw, deps.registry);
    } catch (err) {
      reply.code(409);
      return { machine, state: "not_connectable", message: err instanceof TerminalError ? err.message : "machine is not connectable" };
    }
    let result: TmuxListResult;
    try {
      result = await deps.tmux.list(connectable.target, connectable.handle);
    } catch {
      // The lister is contracted never to throw; if something does, never echo its text (§8/TM-008).
      result = { state: "failed", message: `listing tmux sessions on ${machine} failed` };
    }
    reply.code(result.state === "ok" ? 200 : 502);
    return { machine, ...result };
  });

  // ---- Terminal tab for a machine (guarded) ----
  app.get<{ Params: { logicalName: string } }>("/harness/terminal/:logicalName", async (req, reply) => {
    const machine = deps.registry.getDevMachineByLogicalName(req.params.logicalName);
    const hasMachines = deps.registry.listDevMachines().length > 0;
    const base = requestBase(req);
    const model: TerminalTabModel = machine
      ? { logicalName: machine.logicalName, user: machine.user, host: machine.host, port: machine.port, hasMachines, base }
      : { hasMachines, base };
    reply.type("text/html").send(renderTerminalTab(model));
  });
}
