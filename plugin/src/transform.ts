import { Message, type ContentPart, type ToolCallPart, type ToolResultPart } from "@opencode/ai";
import { Rejected } from "./protocol.js";
import { digest, type SourceUnit, unitRecord, wrappedSummary } from "./source.js";

export function transform(messages: readonly Message[], sessionID: string, units: readonly SourceUnit[],
  summaries: Record<string, string>): Message[] {
  const calls = new Map<string, { part: ToolCallPart; message: Message; index: number }[]>();
  const results = new Map<string, { part: ToolResultPart; message: Message; index: number }[]>();
  messages.forEach((message, index) => {
    if (message.native || message.providerMetadata) throw new Rejected("unsupported_profile", "Opaque message state.");
    for (const part of message.content) {
      if (part.type === "compaction" || part.type === "media" || ("providerMetadata" in part && part.providerMetadata)
        || ("providerExecuted" in part && part.providerExecuted) || (part.type === "reasoning" && part.encrypted)) {
        throw new Rejected("unsupported_profile", "Opaque or media request parts are not qualified.");
      }
      if (part.type === "tool-call") calls.set(part.id, [...(calls.get(part.id) ?? []), { part, message, index }]);
      if (part.type === "tool-result") results.set(part.id, [...(results.get(part.id) ?? []), { part, message, index }]);
    }
  });
  for (const unit of units) {
    const call = calls.get(unit.call_id), result = results.get(unit.call_id);
    if (call?.length !== 1 || result?.length !== 1 || call[0].message.role !== "assistant"
      || result[0].message.role !== "tool" || call[0].index >= result[0].index
      || call[0].message.id !== unit.message_id || call[0].part.name !== result[0].part.name) {
      throw new Rejected("source_changed", "Selected call/result identity or closure changed at the hook.");
    }
    const output = result[0].part.result;
    const content = output.type === "content" ? output.value
      : output.type === "text" && typeof output.value === "string" ? [{ type: "text" as const, text: output.value }] : null;
    if (!content || content.some((part) => part.type !== "text") || digest(unitRecord(sessionID, unit.message_id,
      unit.call_id, call[0].part.name, call[0].part.input, content as SourceUnit["content"])) !== unit.fingerprint) {
      throw new Rejected("source_changed", "Selected arguments or results changed at the hook.");
    }
  }
  // No edit is made until every selected invocation passes validation.
  const selected = new Map(units.map((unit) => [unit.call_id, unit]));
  return messages.flatMap((message) => {
    const content: ContentPart[] = message.content.flatMap((part): ContentPart[] => {
      if (part.type === "tool-call" && selected.has(part.id)) {
        const unit = selected.get(part.id)!;
        return [{ type: "text", text: wrappedSummary(unit, summaries[unit.unit_id]) }];
      }
      if (part.type === "tool-result" && selected.has(part.id)) return [];
      return [part];
    });
    return content.length ? [new Message({ ...message, content })] : [];
  });
}
