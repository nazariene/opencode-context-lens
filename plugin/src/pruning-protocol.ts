import { z } from "zod";

const id = z.string().min(1).max(512);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const pruningScope = z.object({ session_id: id, run_id: id, instance_id: id }).strict();
export const pruningAction = z.enum(["prune-result", "remove-reasoning", "delete-invocation", "delete-range", "summarize-brief", "summarize-full"]);
const errors = { rejected: z.object({ code: z.string(), message: z.string() }).strict() };
export const pruningPreviewInput = pruningScope.extend({ source_guard: hash, revision: z.number().int().nonnegative(),
  target_ids: z.array(id).min(1).max(512), action: pruningAction }).strict();
export const pruningApplyInput = pruningScope.extend({ preview_id: id, operation_id: id }).strict();
export const pruningRestoreInput = pruningScope.extend({ revision: z.number().int().nonnegative(), group_ids: z.array(id).min(1).max(512), operation_id: id }).strict();
export const pruningProtectInput = pruningScope.extend({ target_ids: z.array(id).max(4096), pin_version: z.number().int().nonnegative() }).strict();
// JSON output is assembled server-side; the input and persisted policy are strictly validated.
const output = z.record(z.string(), z.unknown());
export const pruningMethods = {
  pruningCommand: { input: pruningScope.extend({ text: z.string().max(4096) }).strict(), output: z.object({ report: z.string() }), errors },
  pruningInspect: { input: pruningScope, output, errors },
  pruningPreview: { input: pruningPreviewInput, output, errors },
  pruningApply: { input: pruningApplyInput, output, errors },
  pruningRestore: { input: pruningRestoreInput, output, errors },
  pruningProtect: { input: pruningProtectInput, output, errors },
};
