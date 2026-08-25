/**
 * Claude-CLI terminal WebSocket route (Task #16c, ADR-0005 / §9 C.6).
 *
 * `GET /terminal/:logicalName` (WebSocket). Behind the admin guard like every other non-public route
 * (TM-020: terminal access is gated by #9 auth). On connect it opens a key-only SSH PTY to the named
 * DevMachine and bridges it to the socket; the first frame is `{t:"ready", id}` (the reconnect
 * handle). A `?session=<id>` query reattaches to a still-live terminal (reconnectable, §9 C.6) —
 * ONLY if that terminal was opened for the same machine and the same target; otherwise a labeled
 * error frame (never a silent swap to another machine's shell).
 *
 * tmux-aware launcher (M1 task 1): `?tmux=<name>` attaches the PTY to that EXACT tmux session
 * (`tmux attach-session -t =<name>`); `?tmux=<name>&create=1` runs the ruled attach-or-create line.
 * The name is allow-list validated BEFORE any SSH dial — an unsafe name (or a repeated query key)
 * gets a labeled error frame and never reaches a remote command (TM-020, CC2).
 *
 * The heavy lifting (resolve/fail-closed/connect, scrollback, framing) is the unit-tested gateway;
 * this file is the thin ws⇄DuplexSocket adapter. Mount it on an app that already has the #9/admin
 * auth hook (onRequest hooks apply to routes registered afterwards): `await registerTerminalRoute(...)`
 * after `buildApp` and before `listen`.
 */

import websocketPlugin from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { RemoteCommand, TerminalSession } from "../../devmachine/connection.js";
import type { SshTarget } from "../../devmachine/provisioning.js";
import {
  attachSocket,
  openTerminalForMachine,
  TerminalError,
  TerminalRegistry,
  type DuplexSocket,
  type MachineLookup,
  type ManagedTerminal
} from "../../devmachine/terminal-gateway.js";
import { buildTmuxAttachCommand, TmuxError } from "../../devmachine/tmux.js";

export interface TerminalRouteDeps {
  readonly registry: MachineLookup;
  readonly terminals: TerminalRegistry;
  /** Inject the SSH connect step (real: `connectTerminal` bound to custody). */
  readonly connect: (target: SshTarget, handle: string, command?: RemoteCommand) => Promise<TerminalSession>;
}

/** Query values may arrive as arrays when a key is repeated — every consumer narrows explicitly. */
interface TerminalQuery {
  session?: string | string[];
  tmux?: string | string[];
  create?: string | string[];
}

/** Adapt a `ws` WebSocket to the transport-agnostic {@link DuplexSocket} the gateway speaks. */
function adaptWs(socket: WebSocket): DuplexSocket {
  return {
    send: (data) => socket.send(data),
    onMessage: (cb) => socket.on("message", (data: Buffer) => cb(data.toString())),
    onClose: (cb) => socket.on("close", () => cb()),
    close: () => socket.close()
  };
}

/** The remote command for this connection, or undefined for a plain login shell. Throws TmuxError on an unsafe name. */
function remoteCommandFor(query: TerminalQuery): RemoteCommand | undefined {
  if (query.tmux === undefined) return undefined;
  if (typeof query.tmux !== "string") throw new TmuxError("invalid tmux session name — expected exactly one value");
  return buildTmuxAttachCommand(query.tmux, { create: query.create === "1" });
}

export async function registerTerminalRoute(app: FastifyInstance, deps: TerminalRouteDeps): Promise<void> {
  await app.register(websocketPlugin);
  app.get<{ Params: { logicalName: string }; Querystring: TerminalQuery }>(
    "/terminal/:logicalName",
    { websocket: true },
    async (socket, req) => {
      const ws = adaptWs(socket);
      const reconnectId = typeof req.query.session === "string" ? req.query.session : undefined;
      try {
        // Validate the tmux target FIRST so an unsafe name never reaches openTerminalForMachine.
        const command = remoteCommandFor(req.query);
        // Reattach to a still-live terminal if a valid session id was supplied; else open a new one.
        const existing = reconnectId ? deps.terminals.get(reconnectId) : undefined;
        let term: ManagedTerminal;
        if (existing && !existing.isClosed) {
          const origin = existing.origin;
          if (origin && (origin.logicalName !== req.params.logicalName || origin.command !== command)) {
            throw new TerminalError("that session id does not belong to this machine and target — open a new terminal");
          }
          term = existing;
        } else {
          term = await openTerminalForMachine(req.params.logicalName, deps, command === undefined ? {} : { command });
        }
        ws.send(JSON.stringify({ t: "ready", id: term.id }));
        attachSocket(ws, term);
      } catch (err) {
        const known = err instanceof TerminalError || err instanceof TmuxError;
        ws.send(JSON.stringify({ t: "e", m: known ? err.message : "terminal open failed" }));
        ws.close();
      }
    }
  );
}
