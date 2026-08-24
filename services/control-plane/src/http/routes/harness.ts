/**
 * Harness UI routes (Task #16d/e, ADR-0005 §9 C.1/C.6).
 *
 * Serves the harness frame, the xterm.js terminal-tab pages, and the xterm.js static assets. The
 * frame/terminal pages sit behind the #9/admin guard (the operator authenticates once). The
 * `/assets/*` files are PUBLIC (a browser `<script>`/`<link>` can't send an auth header, and xterm is
 * a public library) — they are added to the app's PUBLIC_PATHS. The terminal page only opens a
 * WebSocket to the broker; the SSH key never reaches the browser (TM-020/#14b).
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { FastifyInstance } from "fastify";
import { renderHarnessFrame } from "../harness-frame.js";
import { renderTerminalTab, type TerminalTabModel } from "../terminal-tab.js";
import type { DevMachine } from "../../registry/types.js";

const nodeRequire = createRequire(import.meta.url);
// Read once at startup. xterm ships a UMD bundle + css we serve from our own origin (offline-safe).
const XTERM_JS = readFileSync(nodeRequire.resolve("@xterm/xterm/lib/xterm.js"), "utf8");
const XTERM_CSS = readFileSync(nodeRequire.resolve("@xterm/xterm/css/xterm.css"), "utf8");

/** Public asset paths (added to the app's guard exemption set). */
export const HARNESS_ASSET_PATHS: readonly string[] = ["/assets/xterm.js", "/assets/xterm.css"];

export interface HarnessRoutesDeps {
  readonly registry: {
    listDevMachines(): DevMachine[];
    getDevMachineByLogicalName(logicalName: string): DevMachine | undefined;
  };
  /** Whether operator login is enabled (controls the Log out control in the frame). */
  readonly loginEnabled: boolean;
}

export function registerHarnessRoutes(app: FastifyInstance, deps: HarnessRoutesDeps): void {
  // ---- Static xterm assets (PUBLIC) ----
  app.get("/assets/xterm.js", async (_req, reply) => {
    reply.type("application/javascript").send(XTERM_JS);
  });
  app.get("/assets/xterm.css", async (_req, reply) => {
    reply.type("text/css").send(XTERM_CSS);
  });

  // ---- Harness frame (guarded) ----
  app.get("/harness", async (_req, reply) => {
    reply.type("text/html").send(renderHarnessFrame({ devMachines: deps.registry.listDevMachines(), loginEnabled: deps.loginEnabled }));
  });

  // ---- Terminal tab for a machine (guarded) ----
  app.get<{ Params: { logicalName: string } }>("/harness/terminal/:logicalName", async (req, reply) => {
    const machine = deps.registry.getDevMachineByLogicalName(req.params.logicalName);
    const hasMachines = deps.registry.listDevMachines().length > 0;
    const model: TerminalTabModel = machine
      ? { logicalName: machine.logicalName, user: machine.user, host: machine.host, port: machine.port, hasMachines }
      : { hasMachines };
    reply.type("text/html").send(renderTerminalTab(model));
  });
}
