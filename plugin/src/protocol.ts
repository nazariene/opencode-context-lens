import { Rpc } from "@opencode/plugin/rpc";
import { z } from "zod";
import { pruningMethods } from "./pruning-protocol.js";

export const PROTOCOL = 1;
const id = z.string().min(1).max(512);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const scope = z.object({ session_id: id, run_id: id, instance_id: id }).strict();
export const modelRef = z.object({ providerID: id, id, variant: id.optional() }).strict();
export const selectedUnit = z.object({ unit_id: id, message_id: id, call_id: id, fingerprint: hash }).strict();
export const sourceBundle = scope.extend({ operation_id: id, source_guard: hash,
  units: z.array(selectedUnit).min(1).max(128) }).strict();
export const summaries = z.record(id, z.string().min(1));
const failure = z.object({ code: z.string(), message: z.string() }).strict();
const errors = { rejected: failure };
const identity = { protocol: z.literal(PROTOCOL), instance_id: id };
const evidence = z.object({ at: z.number(), count: z.number().int(), draft_version: z.number().int() }).strict();
export const bundleStatus = z.object({ bundle_id: id, operation_id: id, session_id: id, run_id: id,
  draft_version: z.number().int(), state: z.enum(["registered", "observed-applied", "suspended", "deactivated", "expired"]),
  expires_at: z.number(), reason: z.string().nullable(), evidence: evidence.nullable() }).strict();
export const jobStatus = z.object({ job_id: id, operation_id: id, session_id: id, run_id: id,
  state: z.enum(["running", "completed", "failed", "cancelled", "expired"]), expires_at: z.number(),
  reason: z.string().nullable(), summaries: summaries.nullable(), model: modelRef,
  estimated_input: z.number(), actual_usage: z.null() }).strict();
export const LensRPC = Rpc.define({ id: "context-lens", events: {}, methods: {
  ...pruningMethods,
  capabilities: { input: z.object({}).strict(), output: z.object({ ...identity, host_version: z.string(),
    profiles: z.array(z.string()), generation: z.boolean(), pruning: z.literal(1) }).strict(), errors },
  status: { input: scope.extend({ operation_id: id.optional() }).strict(), output: z.object({ ...identity,
    session_id: id, bundles: z.array(bundleStatus), jobs: z.array(jobStatus) }).strict(), errors },
  generate: { input: sourceBundle.extend({ model: modelRef }).strict(), output: jobStatus, errors },
  generationStatus: { input: scope.extend({ job_id: id }).strict(), output: jobStatus, errors },
  cancelGeneration: { input: scope.extend({ job_id: id }).strict(), output: jobStatus, errors },
  activate: { input: sourceBundle.extend({ draft_version: z.number().int().positive(), summaries }).strict(),
    output: bundleStatus, errors },
  deactivate: { input: scope.extend({ operation_id: id, bundle_id: id }).strict(), output: bundleStatus, errors },
  renew: { input: scope.extend({ bundle_ids: z.array(id).max(64), job_ids: z.array(id).max(4) }).strict(),
    output: z.object({ ...identity, session_id: id, bundles: z.array(bundleStatus), jobs: z.array(jobStatus) }).strict(), errors },
} });

export type Scope = z.infer<typeof scope>;
export type SourceBundle = z.infer<typeof sourceBundle>;
export type SelectedUnit = z.infer<typeof selectedUnit>;
export type ModelRef = z.infer<typeof modelRef>;
export type BundleStatus = z.infer<typeof bundleStatus>;
export type JobStatus = z.infer<typeof jobStatus>;

export class Rejected extends Error {
  constructor(public code: string, message: string) { super(message); }
}
