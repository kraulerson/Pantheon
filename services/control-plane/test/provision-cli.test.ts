/**
 * Provisioning CLI — usage/help contract (Task #16b). The CLI body is thin wiring over the
 * unit-tested orchestration (provisionMachine / provisionAndRecord) and the guarded live path; only
 * the argument-handling branch is pure and worth a direct test (no DB/SSH side effects).
 */

import { describe, it, expect, vi } from "vitest";
import { main } from "../src/cli/provision-devmachine.js";

describe("provision-devmachine CLI argument handling", () => {
  it("exits 2 and prints usage when no logicalName is given", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main([], {})).toBe(2);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/usage:/i));
    err.mockRestore();
  });

  it("exits 0 for --help", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await main(["--help"], {})).toBe(0);
    err.mockRestore();
  });
});
