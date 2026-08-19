/**
 * `POST /api/dev-machines/:id/provision` — set a dev machine up from the harness UI (ADR-0005).
 *
 * Registering a machine only records where it is; it becomes usable when the harness public key is
 * installed on it. That step needed the operator at a terminal, because `ssh-copy-id` prompts on a
 * TTY — so "add a machine" was a job you started in the browser and finished in a shell. This route
 * closes it: the Configuration page collects the machine's password, and the server does the
 * install (see `devmachine/enrollment.ts`) and records the result.
 *
 * The password is request-scoped and travels no further than the enrollment call: it is never
 * persisted, never logged, and never written into a response — including error responses, which is
 * why upstream failure text is replaced rather than forwarded (§8/TM-008). Recording `provisioned`
 * runs through `provisionAndRecord`, so a failed enrollment leaves the row untouched.
 */

import type { FastifyInstance } from "fastify";
import { provisionAndRecord } from "../../devmachine/provision-and-record.js";
import { EnrollmentError, type EnrollmentResult } from "../../devmachine/enrollment.js";
import type { SshTarget } from "../../devmachine/provisioning.js";
import type { DevMachine } from "../../registry/types.js";

export interface EnrollmentRouteDeps {
  readonly registry: {
    listDevMachines(): DevMachine[];
    getDevMachineByLogicalName(logicalName: string): DevMachine | undefined;
    markProvisioned(id: string, keyHandle: string): DevMachine;
  };
  /** Inject the enrollment step (real: `enrollMachine` bound to custody + keygen + ssh2). */
  readonly enroll: (target: SshTarget, handle: string, password: string) => Promise<EnrollmentResult>;
  /** Custody handle of the harness keypair (one shared keypair across machines). */
  readonly keyHandle: string;
}

export function registerEnrollmentRoute(app: FastifyInstance, deps: EnrollmentRouteDeps): void {
  app.post<{ Params: { id: string }; Body: { password?: unknown } }>(
    "/api/dev-machines/:id/provision",
    async (req, reply) => {
      const machine = deps.registry.listDevMachines().find((m) => m.id === req.params.id);
      if (!machine) {
        reply.code(404).send({ error: "not_found" });
        return;
      }

      const password = typeof req.body?.password === "string" ? req.body.password : "";
      if (password === "") {
        reply.code(400).send({ error: "validation_error", detail: "a machine password is required" });
        return;
      }

      try {
        const updated = await provisionAndRecord(machine.logicalName, {
          registry: deps.registry,
          provision: (target, handle) => deps.enroll(target, handle, password),
          keyHandle: deps.keyHandle
        });

        // A form post (urlencoded) came from the Configuration page: send the browser back there
        // with 303 (POST → GET). Deciding on content-type rather than Accept matches how the
        // dev-machine form body is recognised elsewhere, and keeps the operator off a raw JSON
        // page — the same dead end as BUGS #15. JSON callers get the record back.
        const isFormPost = (req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded");
        if (isFormPost) {
          reply.redirect("/admin/config", 303);
          return;
        }
        reply.send(updated);
      } catch (err) {
        // Never forward upstream text: an ssh2 error can quote the credential it was handed.
        const known = err instanceof EnrollmentError;
        reply.code(known ? 400 : 500).send({
          error: known ? "enrollment_failed" : "internal_error",
          detail: known ? (err as EnrollmentError).message : undefined
        });
      }
    }
  );
}
