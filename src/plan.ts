import { parse } from "yaml";
import { CosError } from "./errors.js";
import type { TaskInput } from "./tasks.js";

export interface Plan {
  objective?: string;
  tasks: TaskInput[];
}

function stringList(file: string, where: string, v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return [v];
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  throw new CosError(`${file}: ${where} must be a string or a list of strings`);
}

/** Parses a YAML or JSON plan: `{ objective?, tasks: [{ id?, title, spec, after?, acceptance?, worker?, gate? }] }`. */
export function parsePlan(file: string, text: string): Plan {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new CosError(`${file}: cannot parse plan: ${(err as Error).message}`);
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CosError(`${file}: a plan must be an object with a "tasks" list`);
  }
  const o = raw as Record<string, unknown>;
  if (!Array.isArray(o.tasks) || o.tasks.length === 0) throw new CosError(`${file}: "tasks" must be a non-empty list`);
  if (o.objective !== undefined && typeof o.objective !== "string") throw new CosError(`${file}: "objective" must be a string`);

  const tasks = o.tasks.map((entry, i): TaskInput => {
    const where = `tasks[${i}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new CosError(`${file}: ${where} must be an object`);
    const t = entry as Record<string, unknown>;
    for (const key of ["id", "title", "spec", "worker", "gate"]) {
      if (t[key] !== undefined && typeof t[key] !== "string") throw new CosError(`${file}: ${where}.${key} must be a string`);
    }
    if (typeof t.title !== "string") throw new CosError(`${file}: ${where}.title is required`);
    if (typeof t.spec !== "string") throw new CosError(`${file}: ${where}.spec is required`);
    return {
      id: t.id as string | undefined,
      title: t.title,
      spec: t.spec,
      worker: t.worker as string | undefined,
      gate: t.gate as string | undefined,
      after: stringList(file, `${where}.after`, t.after),
      acceptance: stringList(file, `${where}.acceptance`, t.acceptance),
    };
  });
  return { objective: o.objective as string | undefined, tasks };
}
