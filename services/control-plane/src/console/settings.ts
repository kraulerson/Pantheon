/**
 * Maestro Console settings file (spec §7): poll cadence, card retention, the areas vocabulary, the
 * per-project look and area map, the All-tab areas, the skill → areas map and (F2 Task 7) the
 * per-machine projects root behind the drawer shell and the new-session flow. Schema-validated when
 * loaded; a bad entry is refused with the ENTRY NAME and the RULE, never the offending value (same
 * hygiene as `approvalSourcesFrom`). `reminders` / `telegram` keys are accepted and ignored in F1.
 */

import { remoteDirProblem, TMUX_SESSION_NAME_RE } from "../devmachine/tmux.js";

export interface ProjectSettings {
  readonly display: string;
  readonly glyph: string;
  readonly border: string;
  readonly areas: readonly string[];
  readonly hidden: boolean;
}

/** One dev machine's console settings (F2 Task 7): `machines.<logicalName>` in the settings file. */
export interface MachineSettings {
  /** Absolute directory holding the machine's project folders: the drawer shell starts there; new sessions are made under it. */
  readonly projectsRoot: string;
}

export interface ConsoleSettings {
  readonly pollSeconds: number;
  readonly retention: { readonly cardsDays: number };
  readonly areas: readonly string[];
  /** Key = tmux session name. */
  readonly projects: Readonly<Record<string, ProjectSettings>>;
  readonly allTabAreas: readonly string[];
  /** Skill name → areas. */
  readonly skills: Readonly<Record<string, readonly string[]>>;
  /** Key = dev-machine logical name. A machine without an entry has no drawer shell and no new-session flow. */
  readonly machines: Readonly<Record<string, MachineSettings>>;
}

export type ConsoleSettingsResult =
  | { readonly ok: true; readonly settings: ConsoleSettings }
  | { readonly ok: false; readonly entry: string; readonly message: string };

export const DEFAULT_CONSOLE_SETTINGS: ConsoleSettings = {
  pollSeconds: 5,
  retention: { cardsDays: 90 },
  areas: ["gate-safety", "delivery", "homelab-ops", "fleet-sessions", "memory-hygiene", "learning-recovery", "general"],
  projects: {},
  allTabAreas: ["fleet-sessions", "general"],
  skills: {},
  machines: {},
};

const BORDERS: readonly string[] = ["solid", "dashed", "double", "dotted", "thick-left"];
const DISPLAY_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
const AREA_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,63}$/;
const PROJECT_FIELDS: readonly string[] = ["display", "glyph", "border", "areas", "hidden"];
const PLAIN_KEY_RE = /^[A-Za-z0-9_-]{1,40}$/;
const VISIBLE_RE = /^[^\p{C}\s]+$/u;
/**
 * A `machines` key names a REGISTERED dev machine, so it takes the registry's `LOGICAL_NAME_RE` shape (a leading
 * `_` allowed, never a leading `-` or `.`), capped at 64 characters — the registry is the authority on names (T7-1).
 */
const MACHINE_KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/;
const MACHINE_FIELDS: readonly string[] = ["projectsRoot"];

class Refusal extends Error {
  constructor(readonly entry: string, readonly rule: string) {
    super(rule);
  }
}

const refuse = (entry: string, rule: string): never => {
  throw new Refusal(entry, rule);
};

/** A map key is part of the entry name; clip it so a hostile key cannot flood a log line. */
const keyEntry = (base: string, key: string): string => `${base}[${JSON.stringify(key.length > 40 ? `${key.slice(0, 40)}…` : key)}]`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function objectAt(v: unknown, entry: string): Record<string, unknown> {
  return isObject(v) ? v : refuse(entry, "must be a JSON object");
}

function intAt(v: unknown, entry: string, min: number, max: number): number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : refuse(entry, `must be a whole number from ${min} to ${max}`);
}

function areaListAt(v: unknown, entry: string, allowed: readonly string[] | undefined): readonly string[] {
  if (!Array.isArray(v)) return refuse(entry, "must be a list of area names");
  return v.map((a: unknown, i) => {
    const at = `${entry}[${i}]`;
    if (typeof a !== "string" || !AREA_RE.test(a)) return refuse(at, "must be an area name (lowercase letters, digits, '-', up to 40)");
    if (allowed !== undefined && !allowed.includes(a)) return refuse(at, "must be one of the configured areas");
    return a;
  });
}

function projectFrom(key: string, v: unknown, areas: readonly string[]): ProjectSettings {
  const at = `projects.${key}`;
  const o = objectAt(v, at);
  for (const field of Object.keys(o)) {
    if (!PROJECT_FIELDS.includes(field)) return refuse(PLAIN_KEY_RE.test(field) ? `${at}.${field}` : keyEntry(at, field), "is not a known project setting");
  }
  // The default (the key) already passed TMUX_SESSION_NAME_RE, whose charset is safe, so only an explicit display is checked.
  const explicit = o["display"];
  if (explicit !== undefined && (typeof explicit !== "string" || !DISPLAY_RE.test(explicit))) return refuse(`${at}.display`, "must be 1–40 letters, digits, space, '.', '_' or '-'");
  const display = explicit ?? key;
  const glyph = o["glyph"] === undefined ? "·" : o["glyph"];
  if (typeof glyph !== "string" || !VISIBLE_RE.test(glyph) || Array.from(glyph).length > 2) return refuse(`${at}.glyph`, "must be one to two visible characters");
  const border = o["border"] === undefined ? "solid" : o["border"];
  if (typeof border !== "string" || !BORDERS.includes(border)) return refuse(`${at}.border`, `must be one of ${BORDERS.join(", ")}`);
  const hidden = o["hidden"] === undefined ? false : o["hidden"];
  if (typeof hidden !== "boolean") return refuse(`${at}.hidden`, "must be true or false");
  return {
    display,
    glyph,
    border,
    areas: o["areas"] === undefined ? [] : areaListAt(o["areas"], `${at}.areas`, areas),
    hidden,
  };
}

function machineFrom(key: string, v: unknown): MachineSettings {
  // Always the bracketed entry name: a logical name may contain '.', which a dotted name would make ambiguous.
  const at = keyEntry("machines", key);
  const o = objectAt(v, at);
  for (const field of Object.keys(o)) {
    if (!MACHINE_FIELDS.includes(field)) return refuse(PLAIN_KEY_RE.test(field) ? `${at}.${field}` : keyEntry(at, field), "is not a known machine setting");
  }
  const root = o["projectsRoot"];
  if (typeof root !== "string") return refuse(`${at}.projectsRoot`, "must be an absolute path (a string starting with '/')");
  // The allow-list the command builder applies again at mint time (`tmux new-session -c`): a root it would refuse is refused here, by rule, never by value.
  const problem = remoteDirProblem(root);
  return problem === undefined ? { projectsRoot: root } : refuse(`${at}.projectsRoot`, problem);
}

function parse(raw: string): ConsoleSettings {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return refuse("(file)", "is not valid JSON");
  }
  const root = isObject(parsed) ? parsed : refuse("(file)", "must be a JSON object");
  const d = DEFAULT_CONSOLE_SETTINGS;

  const pollSeconds = root["pollSeconds"] === undefined ? d.pollSeconds : intAt(root["pollSeconds"], "pollSeconds", 2, 60);
  let cardsDays = d.retention.cardsDays;
  if (root["retention"] !== undefined) {
    const r = objectAt(root["retention"], "retention");
    for (const field of Object.keys(r)) {
      if (field !== "cardsDays") return refuse(PLAIN_KEY_RE.test(field) ? `retention.${field}` : keyEntry("retention", field), "is not a known retention setting");
    }
    if (r["cardsDays"] !== undefined) cardsDays = intAt(r["cardsDays"], "retention.cardsDays", 1, 3650);
  }
  const areas = root["areas"] === undefined ? d.areas : areaListAt(root["areas"], "areas", undefined);
  // The default is validated too: an `areas` override that drops "general" / "fleet-sessions" must not leave a dangling default.
  const allTabAreas = areaListAt(root["allTabAreas"] === undefined ? d.allTabAreas : root["allTabAreas"], "allTabAreas", areas);

  // Object.fromEntries defines own properties, so a key like "__proto__" cannot reach the prototype.
  const projects = Object.fromEntries(
    Object.entries(root["projects"] === undefined ? {} : objectAt(root["projects"], "projects")).map(([key, v]) => {
      if (!TMUX_SESSION_NAME_RE.test(key)) return refuse(keyEntry("projects", key), "key must be a tmux session name");
      return [key, projectFrom(key, v, areas)] as const;
    }),
  );
  const skills = Object.fromEntries(
    Object.entries(root["skills"] === undefined ? {} : objectAt(root["skills"], "skills")).map(([name, v]) => {
      if (!SKILL_RE.test(name)) return refuse(keyEntry("skills", name), "key must be a skill name");
      return [name, areaListAt(v, `skills.${name}`, areas)] as const;
    }),
  );

  const machines = Object.fromEntries(
    Object.entries(root["machines"] === undefined ? {} : objectAt(root["machines"], "machines")).map(([key, v]) => {
      if (!MACHINE_KEY_RE.test(key)) return refuse(keyEntry("machines", key), "key must be a dev-machine logical name");
      return [key, machineFrom(key, v)] as const;
    }),
  );

  return { pollSeconds, retention: { cardsDays }, areas, projects, allTabAreas, skills, machines };
}

/** Parse the file text. `undefined` / blank → the defaults. Never echoes a value in a refusal. */
export function consoleSettingsFrom(raw: string | undefined): ConsoleSettingsResult {
  if (raw === undefined || raw.trim() === "") return { ok: true, settings: DEFAULT_CONSOLE_SETTINGS };
  try {
    return { ok: true, settings: parse(raw) };
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, entry: e.entry, message: `${e.entry} ${e.rule}` };
    throw e;
  }
}

/** `readFile` returns the text, or `undefined` for a missing file (→ defaults). Other I/O errors propagate. */
export function loadConsoleSettings(path: string, readFile: (p: string) => string | undefined): ConsoleSettingsResult {
  return consoleSettingsFrom(readFile(path));
}

/** The machine's configured projects root (own entries only), or undefined: no drawer shell and no new-session flow for it. */
export function projectsRootFor(settings: ConsoleSettings, logicalName: string): string | undefined {
  return Object.hasOwn(settings.machines, logicalName) ? settings.machines[logicalName]?.projectsRoot : undefined;
}
