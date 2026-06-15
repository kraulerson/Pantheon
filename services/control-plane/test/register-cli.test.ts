/**
 * register-devmachine CLI — Task #16f. Inserts a DevMachine row directly so the operator can
 * register a machine without the running guarded API, then provision it. Only the arg parsing is
 * pure (the registry write is RegistryService.createDevMachine, already tested).
 */

import { describe, it, expect } from "vitest";
import { parseRegisterArgs } from "../src/cli/register-devmachine.js";

describe("parseRegisterArgs", () => {
  it("parses name/host/user and defaults port to 22", () => {
    expect(parseRegisterArgs(["--name", "mac-studio", "--host", "192.168.1.192", "--user", "karl"])).toEqual({
      logicalName: "mac-studio",
      host: "192.168.1.192",
      user: "karl",
      port: 22,
      enabled: true
    });
  });

  it("honors an explicit --port", () => {
    expect(parseRegisterArgs(["--name", "m", "--host", "h", "--user", "u", "--port", "2222"]).port).toBe(2222);
  });

  it("throws when a required flag is missing", () => {
    expect(() => parseRegisterArgs(["--host", "h", "--user", "u"])).toThrow(/name/i);
    expect(() => parseRegisterArgs(["--name", "m", "--user", "u"])).toThrow(/host/i);
    expect(() => parseRegisterArgs(["--name", "m", "--host", "h"])).toThrow(/user/i);
  });

  it("throws on a non-numeric --port", () => {
    expect(() => parseRegisterArgs(["--name", "m", "--host", "h", "--user", "u", "--port", "abc"])).toThrow(/port/i);
  });
});
