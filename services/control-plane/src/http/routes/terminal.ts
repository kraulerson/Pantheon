/**
 * Claude-CLI terminal WebSocket route (Task #16c, ADR-0005 / §9 C.6).
 *
 * `GET /terminal/:logicalName` (WebSocket). Behind the admin guard like every other non-public route
 * (TM-020: terminal access is gated by #9 auth). On connect it opens a key-only SSH PTY to the named
 * DevMachine and bridges it to the socket; the first frame is `{t:"ready", id}` (the reconnect
 * handle). A `?session=<id>` query reattaches to a still-live terminal (reconnectable, §9 C.6).
 *
 * The heavy lifting (resolve/fail-closed/connect, scrollback, framing) is the unit-tested gateway;
 * this file is the thin ws⇄DuplexSocket adapter. Mount it on an app that already has the #9/admin
 * auth hook (onRequest hooks apply to routes registered afterwards): `await registerTerminalRoute(...)`
 * after `buildApp` and before `listen`.
 */

import websocketPlugin from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import type { DevMachine } from "../../registry/types.js";
import type { TerminalSession } from "../../devmachine/connection.js";
import type { SshTarget } from "../../devmachine/provisioning.js";
import {
  attachSocket,
  openTerminalForMachine,
  TerminalError,
  TerminalRegistry,
  type DuplexSocket
} from "../../devmachine/terminal-gateway.js";

export interface TerminalRouteDeps {
  readonly registry: { getDevMachineByLogicalName(logicalName: string): DevMachine | undefined };
  readonly terminals: TerminalRegistry;
  /** Inject the SSH connect step (real: `connectTerminal` bound to custody). */
  readonly connect: (target: SshTarget, handle: string) => Promise<TerminalSession>;
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

export async function registerTerminalRoute(app: FastifyInstance, deps: TerminalRouteDeps): Promise<void> {
  await app.register(websocketPlugin);
  app.get<{ Params: { logicalName: string }; Querystring: { session?: string } }>(
    "/terminal/:logicalName",
    { websocket: true },
    async (socket, req) => {
      const ws = adaptWs(socket);
      const reconnectId = req.query.session;
      try {
        // Reattach to a still-live terminal if a valid session id was supplied; else open a new one.
        const existing = reconnectId ? deps.terminals.get(reconnectId) : undefined;
        const term = existing && !existing.isClosed ? existing : await openTerminalForMachine(req.params.logicalName, deps);
        ws.send(JSON.stringify({ t: "ready", id: term.id }));
        attachSocket(ws, term);
      } catch (err) {
        ws.send(JSON.stringify({ t: "e", m: err instanceof TerminalError ? err.message : "terminal open failed" }));
        ws.close();
      }
    }
  );
}
