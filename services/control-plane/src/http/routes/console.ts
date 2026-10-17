/**
 * Maestro Console routes (plan Task 10; spec §6, §9; ADR-0010). Three GET routes, every one behind the
 * operator guard `app.ts` runs before routing (302 → /login for a browser, 401 for an API caller, 403 for a
 * keycard bearer — TM-011); none of them joins PUBLIC_PATHS.
 *
 *   GET /console                       → the Task 11 page (text/html; the app's onSend hook makes it no-store)
 *   GET /console/api/state             → { machines, sessions, cards, settings }   Cache-Control: no-store
 *   GET /console/api/cards/:id/expand  → ExpandResult                              Cache-Control: no-store
 *
 * Trust boundary (R1): the state payload is the store's masked faces plus the poller's health; a session's
 * `cwd`, `procStart` and `waitingFor` never leave the server (an explicit allow-list projection, so a column added
 * to the row type is a compile error here until it is deliberately exposed; the page uses none of the three, and
 * `stateReason` already carries the masked waitingFor — final review M1). The expand route dials the card's
 * machine on demand through `expandCard`, with the output cap derived from the card's own byte range; nothing is
 * persisted.
 * Every error outcome is a labelled state with a first-party message: a fixed text for a malformed or unknown
 * id, the gateway's own refusal for a machine that may not be dialled (logicalName only, never user@host),
 * and `expandCard`'s messages otherwise — never an exception's text (§8/TM-008).
 */

import type { FastifyInstance } from "fastify";
import { expandCard, type ExpandResult } from "../../console/expand.js";
import type { ConsolePoller, MachineHealth } from "../../console/poller.js";
import { PROBE_MAX_OUTPUT_BYTES } from "../../console/probe-command.js";
import type { ConsoleSettingsResult, ProjectSettings } from "../../console/settings.js";
import type { ConsoleCardRow, ConsoleSessionRow, SqliteConsoleStore } from "../../console/store.js";
import type { RemoteCommand, RemoteCommandOptions, RemoteCommandResult } from "../../devmachine/connection.js";
import type { SshTarget } from "../../devmachine/provisioning.js";
import { resolveConnectableMachine, TerminalError, type ConnectableMachine } from "../../devmachine/terminal-gateway.js";
import type { RemoteExec } from "../../devmachine/tmux.js";
import { requestBase } from "../base-path.js";
import { renderConsolePage } from "../console-page.js";
import type { HarnessRoutesDeps } from "./harness.js";

/** A card id is the store's 32-hex digest; anything else is refused with a fixed message (never echoed). */
export const CARD_ID_RE = /^[0-9a-f]{32}$/;
/** Per-expand budget, connect + run (the probe's own 4 s). */
export const EXPAND_TIMEOUT_MS = 4000;
/**
 * Cards in one state payload, per group: up to this many needs-you cards (newest first), then up to this many of
 * the newest cards not already listed — so a needs-you card older than the newest 200 still reaches the page
 * (final review I4).
 */
const STATE_CARD_LIMIT = 200;
/** Room for the login banner, the record prefix and the end marker around the base64 slice. */
const EXPAND_SLACK_BYTES = 4096;

/**
 * `runRemoteCommand` bound to key custody, with the per-command output cap and timeout left to the caller:
 * the expand route caps each dial to the card's own range (a `RemoteExec` carries no options).
 */
export type ConsoleRemoteRun = (
  target: SshTarget,
  handle: string,
  command: RemoteCommand,
  opts: Required<RemoteCommandOptions>
) => Promise<RemoteCommandResult>;

export interface ConsoleRoutesDeps {
  readonly registry: HarnessRoutesDeps["registry"];
  readonly store: SqliteConsoleStore;
  readonly poller: ConsolePoller;
  /** The loaded settings file; a refused file disables the page (banner naming the entry) and the API says so. */
  readonly settings: ConsoleSettingsResult;
  readonly exec: ConsoleRemoteRun;
  readonly mask: (t: string) => string;
  /** Whether operator login is enabled (controls the Log out control on the page). */
  readonly loginEnabled: boolean;
}

/** What `server.ts` supplies through `AppOptions.console`; `app.ts` adds the registry and `loginEnabled`. */
export type ConsoleWiring = Pick<ConsoleRoutesDeps, "store" | "poller" | "settings" | "exec" | "mask">;

/** A session as the API shows it: the stored row minus `cwd`, `procStart` and `waitingFor` (final review M1). */
export type ConsoleApiSession = Omit<ConsoleSessionRow, "cwd" | "procStart" | "waitingFor">;

export type ConsoleApiSettings =
  | { readonly pollSeconds: number; readonly allTabAreas: readonly string[]; readonly projects: Readonly<Record<string, ProjectSettings>> }
  | { readonly disabled: true; readonly entry: string };

export interface ConsoleStatePayload {
  readonly machines: readonly MachineHealth[];
  readonly sessions: readonly ConsoleApiSession[];
  /** Needs-you cards first, then the rest; newest first within each group. */
  readonly cards: readonly ConsoleCardRow[];
  readonly settings: ConsoleApiSettings;
}

/** An explicit allow-list, not a rest spread: a field added to `ConsoleSessionRow` fails to compile here until it is deliberately exposed. */
function apiSession(r: ConsoleSessionRow): ConsoleApiSession {
  return {
    machine: r.machine,
    tmuxSession: r.tmuxSession,
    paneId: r.paneId,
    claudePid: r.claudePid,
    sessionId: r.sessionId,
    projectKey: r.projectKey,
    reachable: r.reachable,
    status: r.status,
    state: r.state,
    stateReason: r.stateReason,
    transcriptOffset: r.transcriptOffset,
    transcriptSize: r.transcriptSize,
    lastSeenAt: r.lastSeenAt,
    endedAt: r.endedAt,
    version: r.version,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt
  };
}

/** The card's range as base64 (4/3) plus the probe's framing, never above the probe's own cap. */
const expandOutputCap = (card: ConsoleCardRow): number =>
  Math.min(PROBE_MAX_OUTPUT_BYTES, Math.ceil(((card.byteEnd - card.byteStart) * 4) / 3) + EXPAND_SLACK_BYTES);

export function registerConsoleRoutes(app: FastifyInstance, deps: ConsoleRoutesDeps): void {
  const settings = deps.settings;

  // ---- The page (guarded; text/html → the app's onSend hook adds no-store and frame-ancestors 'self') ----
  app.get("/console", async (req, reply) => {
    reply
      .type("text/html")
      .send(renderConsolePage({ base: requestBase(req), loginEnabled: deps.loginEnabled, ...(settings.ok ? {} : { disabled: { entry: settings.entry } }) }));
  });

  // ---- State the page polls (guarded; JSON; no-store) ----
  app.get("/console/api/state", async (_req, reply): Promise<ConsoleStatePayload> => {
    reply.header("Cache-Control", "no-store");
    const flagged = deps.store.listCards({ needsYouOnly: true }, STATE_CARD_LIMIT);
    const listed = new Set(flagged.map((c) => c.id));
    const newest = deps.store.listCards({}, STATE_CARD_LIMIT).filter((c) => !listed.has(c.id));
    return {
      machines: deps.poller.health(),
      sessions: deps.store.listSessions().map(apiSession),
      cards: [...flagged, ...newest],
      settings: settings.ok
        ? { pollSeconds: settings.settings.pollSeconds, allTabAreas: settings.settings.allTabAreas, projects: settings.settings.projects }
        : { disabled: true, entry: settings.entry }
    };
  });

  // ---- On-demand expand of one card (guarded; JSON; no-store; labelled states) ----
  app.get<{ Params: { id: string } }>("/console/api/cards/:id/expand", async (req, reply): Promise<ExpandResult> => {
    reply.header("Cache-Control", "no-store");
    const id = req.params.id;
    if (!CARD_ID_RE.test(id)) {
      reply.code(400);
      return { state: "failed", message: "unexpected card id" };
    }
    const card = deps.store.getCard(id);
    if (card === undefined) {
      reply.code(404);
      return { state: "failed", message: "no such card" };
    }
    let conn: ConnectableMachine;
    try {
      // The same fail-closed rule as opening a terminal: unknown / disabled / unprovisioned never dials (TM-020).
      conn = resolveConnectableMachine(card.machine, deps.registry);
    } catch (err) {
      reply.code(409);
      return { state: "failed", message: err instanceof TerminalError ? err.message : "machine is not connectable" };
    }
    const opts = { maxOutputBytes: expandOutputCap(card), timeoutMs: EXPAND_TIMEOUT_MS };
    const exec: RemoteExec = (target, handle, command) => deps.exec(target, handle, command, opts);
    const result = await expandCard(card, conn.target, conn.handle, exec, deps.mask);
    reply.code(result.state === "ok" || result.state === "changed" ? 200 : 502);
    return result;
  });
}
