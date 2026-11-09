import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import { Rejected } from "./protocol.js";

// Only these source fields participate in protocol v1. Runtime metadata and
// provider counters are deliberately excluded; tool arguments are never filtered.
const messageFields = ["id", "type", "text", "name", "description", "files", "command", "output",
  "status", "summary", "recent", "providerContext", "providerState", "native"];
const contentFields = ["type", "id", "name", "text", "state", "executed", "providerState", "providerResultState", "native"];
const stateFields = ["status", "input", "content", "error", "reasoningEncryptedContent"];
type ObjectValue = Record<string, any>;

export type Checkpoint = { id: string | null; time: number };
export function checkpoint(messages: readonly ObjectValue[]): Checkpoint {
  return { id: messages.find((message) => message.type === "compaction" && message.status === "completed")?.id ?? null,
    time: messages.reduce((time, message) => Math.max(time, message.time?.created ?? 0), 0) };
}
export const afterCheckpoint = (current: Checkpoint, baseline: Checkpoint) => current.id !== null
  && current.id !== baseline.id && current.time >= baseline.time;

function pick(value: ObjectValue, fields: string[]) {
  return Object.fromEntries(fields.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]));
}

export function representable(value: unknown): void {
  if (typeof value === "number" && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))) {
    throw new Rejected("unsupported_source", "Source has a number outside the interoperable JSON range.");
  }
  if (typeof value === "string" && /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value)) {
    throw new Rejected("unsupported_source", "Source contains an unpaired Unicode surrogate.");
  }
  if (Array.isArray(value)) value.forEach(representable);
  else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) { representable(key); representable(entry); }
  }
}

export function digest(value: unknown): string {
  representable(value);
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function sourceRecord(session: ObjectValue, messages: readonly ObjectValue[]) {
  return { protocol: 1, session_id: session.id, location: session.location, model: session.model ?? null,
    messages: messages.map((message) => {
      const result = pick(message, messageFields);
      if (message.type === "compaction" && message.metadata) {
        const retained = pick(message.metadata, ["recent", "keepID"]);
        if (Object.keys(retained).length) result.metadata = retained;
      }
      if (message.content) result.content = message.content.map((content: ObjectValue) => {
        const part = pick(content, contentFields);
        if (content.state) part.state = pick(content.state, stateFields);
        return part;
      });
      return result;
    }) };
}

export interface SourceUnit {
  unit_id: string;
  message_id: string;
  call_id: string;
  name: string;
  input: unknown;
  content: { type: "text"; text: string }[];
  fingerprint: string;
}

export function unitRecord(sessionID: string, messageID: string, callID: string, name: string,
  input: unknown, content: { type: "text"; text: string }[]) {
  return { protocol: 1, session_id: sessionID, message_id: messageID, call_id: callID,
    name, status: "completed", input, content };
}

export function sourceUnits(session: ObjectValue, messages: readonly ObjectValue[]): Map<string, SourceUnit> {
  const calls = messages.flatMap((message) => (message.content ?? []).filter((c: ObjectValue) => c.type === "tool"));
  const counts = new Map<string, number>();
  for (const call of calls) counts.set(call.id, (counts.get(call.id) ?? 0) + 1);
  const units = new Map<string, SourceUnit>();
  for (const message of messages) {
    (message.content ?? []).forEach((call: ObjectValue, index: number) => {
      if (call.type !== "tool") return;
      const state = call.state ?? {};
      if (!call.id || counts.get(call.id) !== 1 || state.status !== "completed" || state.error
        || !state.content?.length || state.content.some((entry: ObjectValue) => entry.type !== "text")
        || message.native || call.native || call.executed || call.providerState || call.providerResultState || call.name.split(".").at(-1) === "skill") return;
      const fingerprint = digest(unitRecord(session.id, message.id, call.id, call.name, state.input, state.content));
      const unit_id = `${message.id}:${index}`;
      units.set(unit_id, { unit_id, message_id: message.id, call_id: call.id, name: call.name,
        input: state.input, content: state.content, fingerprint });
    });
  }
  return units;
}

export function plainReasoningState(state: ObjectValue | undefined): boolean {
  return !state || !Object.keys(state).length || Object.keys(state).length === 1
    && ["reasoning_content", "reasoning"].includes(state.reasoningField);
}

export function rejectOpaque(messages: readonly ObjectValue[], allowPlainReasoning = false): void {
  for (const message of messages) {
    if (message.native || message.providerContext || message.providerState || message.files?.length) {
      throw new Rejected("unsupported_profile", "Native provider state or media is not qualified for replacement.");
    }
    for (const content of message.content ?? []) {
      if (content.executed || content.providerState || content.providerResultState
        || content.native && !(allowPlainReasoning && content.type === "reasoning" && plainReasoningState(content.native))
        || (content.type !== "tool" && content.state && Object.keys(content.state).length
          && !(allowPlainReasoning && content.type === "reasoning" && plainReasoningState(content.state)))) {
        throw new Rejected("unsupported_profile", "Opaque or provider-executed content is not qualified.");
      }
    }
  }
}

export function wrappedSummary(unit: Pick<SourceUnit, "name" | "call_id">, summary: string): string {
  return `Context Lens summary of ${unit.name} [${unit.call_id}]:\n${summary}`;
}

export function validateSummaries(ids: string[], summaries: Record<string, string>): void {
  if (ids.length !== Object.keys(summaries).length || ids.some((id) => !(id in summaries))) {
    throw new Rejected("invalid_summaries", "Provide exactly one summary for every selected unit.");
  }
  let bytes = 0;
  for (const text of Object.values(summaries)) {
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 16384) {
      throw new Rejected("invalid_summaries", "Each summary must be nonempty and at most 16 KiB.");
    }
    bytes += Buffer.byteLength(text);
  }
  if (bytes > 49152) throw new Rejected("size_limit", "Combined summaries exceed 48 KiB.");
}
