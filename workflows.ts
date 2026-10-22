// Reads the `workflow_dispatch` trigger and its inputs from workflow YAML.
import { parse } from "yaml";
import { z } from "zod";

export const dispatchInputSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  required: z.boolean(),
  type: z.enum(["string", "choice", "boolean", "number", "environment"]),
  default: z.string().nullable(),
  options: z.array(z.string()),
});
export type DispatchInput = z.infer<typeof dispatchInputSchema>;

export interface DispatchSpec {
  /** False when the workflow has no `workflow_dispatch` trigger. */
  dispatchable: boolean;
  inputs: DispatchInput[];
}

const NOT_DISPATCHABLE: DispatchSpec = { dispatchable: false, inputs: [] };

function scalar(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return null;
  return String(value);
}

export function parseDispatchSpec(source: string): DispatchSpec {
  let doc: unknown;
  try {
    doc = parse(source);
  } catch {
    return NOT_DISPATCHABLE;
  }
  if (typeof doc !== "object" || doc === null) return NOT_DISPATCHABLE;
  // YAML 1.1 readers turn a bare `on:` key into `true`; `yaml` keeps "on".
  const on = (doc as Record<string, unknown>).on ?? (doc as Record<string, unknown>).true;
  if (on === "workflow_dispatch") return { dispatchable: true, inputs: [] };
  if (Array.isArray(on)) {
    return on.includes("workflow_dispatch")
      ? { dispatchable: true, inputs: [] }
      : NOT_DISPATCHABLE;
  }
  if (typeof on !== "object" || on === null || !("workflow_dispatch" in on)) {
    return NOT_DISPATCHABLE;
  }
  const trigger = (on as Record<string, unknown>).workflow_dispatch;
  const rawInputs =
    typeof trigger === "object" && trigger !== null
      ? (trigger as Record<string, unknown>).inputs
      : undefined;
  if (typeof rawInputs !== "object" || rawInputs === null) {
    return { dispatchable: true, inputs: [] };
  }
  const inputs: DispatchInput[] = [];
  for (const [name, raw] of Object.entries(rawInputs as Record<string, unknown>)) {
    const spec = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    const declared = scalar(spec.type);
    const type = dispatchInputSchema.shape.type.safeParse(declared).success
      ? (declared as DispatchInput["type"])
      : "string";
    inputs.push({
      name,
      description: scalar(spec.description),
      required: spec.required === true,
      type,
      default: scalar(spec.default),
      options: Array.isArray(spec.options)
        ? spec.options.map((option) => String(option))
        : [],
    });
  }
  return { dispatchable: true, inputs };
}
