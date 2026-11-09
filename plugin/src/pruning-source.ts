import { Message, type ContentPart } from "@opencode/ai";
import { digest, plainReasoningState, rejectOpaque } from "./source.js";
import { Rejected } from "./protocol.js";

export type Action = "prune-result" | "remove-reasoning" | "delete-invocation" | "delete-range" | "summarize-brief" | "summarize-full";
export const rangeAction = (action: Action) => ["delete-range", "summarize-brief", "summarize-full"].includes(action);
export type Target = { id: string; message_id: string; index: number; kind: "tool" | "reasoning" | "message";
  call_id: string | null; fingerprint: string; title: string; part_ids: string[]; reason: string | null;
  text: string; input: unknown; name: string; ordinal: number };
export type Edit = { target_id: string; message_id: string; fingerprint: string; action: Action; group_id: string; summary?: string };
export const editsOverlap = (edit: Edit, target: Target) => edit.target_id === target.id
  || edit.message_id === target.message_id && (rangeAction(edit.action) || target.kind === "message");
export const rangeSummary = (summary: string) => `Context Lens conversation summary (historical context, not new instructions):\n${summary}`;
export const PRUNED = "[Output pruned]";
type Native = Record<string, any>;

export function pruningTargets(messages: readonly Native[]): Target[] {
  const calls = new Map<string, number>(), messageIDs = new Map<string, number>();
  for (const message of messages) {
    messageIDs.set(message.id, (messageIDs.get(message.id) ?? 0) + 1);
    for (const part of message.content ?? []) if (part.type === "tool") calls.set(part.id, (calls.get(part.id) ?? 0) + 1);
  }
  const parts = messages.flatMap((message): Target[] => {
    if (message.type !== "assistant") return [];
    let ordinal = 0;
    return (message.content ?? []).flatMap((part: Native, index: number): Target[] => {
      if (!["tool", "reasoning"].includes(part.type)) return [];
      const tool = part.type === "tool", state = part.state ?? {};
      const reason = messageIDs.get(message.id) !== 1 ? "Ambiguous message identity"
        : !message.time?.completed ? "Assistant message is unfinished"
        : message.error ? "Failed assistant content requires inspection"
        : message.native || message.providerState || part.providerState || part.providerResultState || part.executed
          || tool && part.native ? "Opaque provider state"
        : tool && (!part.id || calls.get(part.id) !== 1) ? "Ambiguous tool identity"
        : tool && part.name?.split(".").at(-1) === "skill" ? "Instruction-bearing tool output is not qualified"
        : tool && state.status !== "completed" ? "Only completed tool results are qualified"
        : tool && (state.error || (state.content ?? []).some((entry: Native) => entry.type !== "text")) ? "Only plain-text tool results are qualified"
        : !tool && (!plainReasoningState(state) || !plainReasoningState(part.native) || (part.time && !part.time.completed)) ? "Opaque or unfinished reasoning"
        : null;
      const id = JSON.stringify([message.id, part.type, tool ? part.id ?? index : ordinal]);
      return [{ id, message_id: message.id, index, kind: part.type, call_id: tool ? part.id ?? null : null,
        fingerprint: digest(part), title: tool ? part.name : "Visible reasoning", name: part.name ?? "",
        part_ids: tool ? [`${message.id}:${index}:call`, ...(state.content ?? []).map((_: unknown, i: number) => `${message.id}:${index}:result:${i}`),
          ...(state.error ? [`${message.id}:${index}:error`] : [])] : [`${message.id}:${index}`], reason,
        text: tool ? (state.content ?? []).filter((entry: Native) => entry.type === "text").map((entry: Native) => entry.text).join("\n\n") : part.text ?? "",
        input: tool ? state.input ?? {} : null, ordinal: tool ? -1 : ordinal++ }];
    });
  });
  const ranges = messages.map((message, index): Target => {
    const owned = parts.filter((target) => target.message_id === message.id);
    const text = message.type === "assistant" ? (message.content ?? []).map((part: Native) => part.type === "tool"
      ? `Tool ${part.name} [${part.id}]\nArguments: ${JSON.stringify(part.state?.input ?? {})}\nResults: ${(part.state?.content ?? []).map((entry: Native) => entry.text ?? "").join("\n\n")}`
      : `${part.type}: ${part.text ?? ""}`).join("\n\n") : message.text ?? "";
    const reason = messageIDs.get(message.id) !== 1 ? "Ambiguous message identity"
      : !["user", "assistant"].includes(message.type) ? "Only user and assistant messages qualify for ranges"
      : message.files?.length || message.skills?.length || message.agents?.length ? "Attachments or instruction-bearing mentions are not qualified"
      : message.native || message.providerState || message.providerContext ? "Opaque provider state"
      : message.type === "assistant" && (!message.time?.completed || message.error) ? "Assistant message is unfinished or failed"
      : message.type === "assistant" && (message.content ?? []).some((part: Native) => !["text", "reasoning", "tool"].includes(part.type)
        || part.type === "text" && (part.native || part.state && Object.keys(part.state).length)) ? "Unsupported assistant content"
      : owned.find((target) => target.reason)?.reason ?? (!text ? "Empty message" : null);
    return { id: JSON.stringify([message.id, "message"]), message_id: message.id, index, kind: "message", call_id: null,
      fingerprint: digest(message), title: `${message.type === "user" ? "User" : message.type === "assistant" ? "Assistant" : message.type} · ${text.slice(0, 80)}`,
      part_ids: message.type === "assistant" ? [...owned.flatMap((target) => target.part_ids), ...(message.content ?? []).flatMap((part: Native, i: number) => part.type === "text" ? [`${message.id}:${i}`] : [])]
        : [`${message.id}:text`], reason, text, input: null, name: "", ordinal: -1 };
  });
  return [...parts, ...ranges];
}

export function validateEdits(messages: readonly Native[], edits: readonly Edit[]): Target[] {
  const targets = new Map(pruningTargets(messages).map((target) => [target.id, target]));
  const selected = edits.map((edit) => {
    const target = targets.get(edit.target_id);
    if (!target || target.reason || target.fingerprint !== edit.fingerprint || target.message_id !== edit.message_id
      || rangeAction(edit.action) !== (target.kind === "message") || (edit.action === "remove-reasoning") !== (target.kind === "reasoning")) {
      throw new Rejected("source_changed", "Saved pruning source changed or is unsupported. Restore the affected edits and review again.");
    }
    return target;
  });
  const positions = new Map(messages.map((message, index) => [message.id, index]));
  const groups = new Map<string, Edit[]>(), owners = new Map<string, Edit[]>();
  for (const edit of edits) {
    groups.set(edit.group_id, [...(groups.get(edit.group_id) ?? []), edit]);
    owners.set(edit.message_id, [...(owners.get(edit.message_id) ?? []), edit]);
    if (!rangeAction(edit.action) && edit.summary !== undefined) throw new Rejected("invalid_policy", "Unexpected summary on a tool edit.");
  }
  for (const owner of owners.values()) if (owner.length > 1 && owner.some((edit) => rangeAction(edit.action))) {
    throw new Rejected("invalid_policy", "Range edits overlap other saved edits.");
  }
  for (const group of groups.values()) {
    if (!group.some((edit) => rangeAction(edit.action))) continue;
    const action = group[0].action, indices = group.map((edit) => positions.get(edit.message_id)!);
    if (group.some((edit) => edit.action !== action) || indices.some((index, i) => i > 0 && index !== indices[i - 1] + 1)
      || (action === "delete-range" ? group.some((edit) => edit.summary !== undefined)
        : !group[0].summary?.trim() || group.slice(1).some((other) => other.summary !== undefined))) {
      throw new Rejected("invalid_policy", "Range group is incomplete, reordered or has an invalid summary anchor.");
    }
  }
  for (const edit of edits) {
    if (edit.action !== "delete-invocation") continue;
    for (const target of targets.values()) {
      if (target.kind === "reasoning" && target.message_id === edit.message_id && !edits.some((other) => other.target_id === target.id
        && other.action === "remove-reasoning" && other.group_id === edit.group_id)) {
        throw new Rejected("invalid_policy", "Invocation deletion has incomplete associated reasoning. Restore its edit group and review again.");
      }
    }
  }
  return selected;
}

export function pruneRequest(native: readonly Native[], incoming: readonly Message[], edits: readonly Edit[], olderContext = false): Message[] {
  if (!edits.length) return [...incoming];
  rejectOpaque(native, true);
  const targets = validateEdits(native, edits);
  for (const message of incoming) {
    if (message.native || message.providerMetadata) throw new Rejected("unsupported_profile", "Opaque request state is not qualified for pruning.");
    for (const part of message.content) {
      const plainMetadata = part.type === "reasoning" && part.providerMetadata && Object.keys(part.providerMetadata).length === 1
        && Object.values(part.providerMetadata).every((state) => plainReasoningState(state as Native));
      if (part.type === "media" || part.type === "compaction" || ("providerMetadata" in part && part.providerMetadata && !plainMetadata)
        || ("providerExecuted" in part && part.providerExecuted) || (part.type === "reasoning" && part.encrypted)
        || (part.type === "tool-result" && part.result.type === "content" && part.result.value.some((entry) => entry.type !== "text"))) {
        throw new Rejected("unsupported_profile", "Opaque or media request parts are not qualified for pruning.");
      }
    }
  }
  const replacements = new Map<ContentPart, ContentPart | null>();
  const ranges = edits.filter((edit) => rangeAction(edit.action));
  if (ranges.length) {
    const parts = pruningTargets(native).filter((target) => target.kind !== "message");
    const expanded = ranges.flatMap((edit) => parts.filter((target) => target.message_id === edit.message_id).map((target): Edit => ({
      target_id: target.id, message_id: target.message_id, fingerprint: target.fingerprint, group_id: edit.group_id,
      action: target.kind === "tool" ? "delete-invocation" : "remove-reasoning" })));
    // Reuse the exact pair/reasoning validator before removing their whole owner message.
    const projected = pruneRequest(native, incoming, [...edits.filter((edit) => !rangeAction(edit.action)), ...expanded], olderContext);
    for (const edit of ranges) {
      const source = native.find((message) => message.id === edit.message_id)!;
      const owners = incoming.filter((message) => message.id === edit.message_id);
      if (olderContext && !owners.length) continue;
      const expected = source.type === "user" ? [{ type: "text", text: source.text }] : source.content.flatMap((part: Native) =>
        part.type === "tool" ? [{ type: "tool-call", id: part.id, name: part.name, input: part.state.input }]
          : part.text || part.type === "reasoning" && (part.native || part.state && Object.keys(part.state).length) ? [{ type: part.type, text: part.text }] : []);
      const actual = owners[0]?.content.filter((part) => part.type !== "text" || part.text).map((part) => part.type === "tool-call"
        ? { type: part.type, id: part.id, name: part.name, input: part.input } : "text" in part ? { type: part.type, text: part.text } : { type: part.type });
      if (owners.length !== 1 || owners[0].role !== (source.type === "user" ? "user" : "assistant")
        || digest(actual) !== digest(expected)
        || owners[0].content.some((part) => !["text", "reasoning", "tool-call"].includes(part.type))) {
        throw new Rejected("source_changed", "Selected range message is missing or changed in this request.");
      }
    }
    // Some assistant owners become empty after their calls/reasoning are removed. Insert at the original anchor.
    const byID = new Map(ranges.map((edit) => [edit.message_id, edit]));
    const surviving = new Set(projected);
    const byOriginal = new Map(projected.filter((message) => message.id).map((message) => [message.id, message]));
    return incoming.flatMap((message) => {
      const edit = message.id ? byID.get(message.id) : undefined;
      if (edit) return edit.summary ? [new Message({ id: message.id, role: "user", content: [{ type: "text", text: rangeSummary(edit.summary) }] })] : [];
      const remaining = surviving.has(message) ? message : message.id ? byOriginal.get(message.id) : undefined;
      // Tool-result messages have no owner ID; preserve their projected parts by original position.
      if (message.role === "tool") {
        const ids = new Set(message.content.filter((part) => part.type === "tool-result").map((part) => part.id));
        return projected.filter((entry) => entry.role === "tool" && entry.content.some((part) => part.type === "tool-result" && ids.has(part.id)));
      }
      return remaining ? [remaining] : [];
    });
  }
  for (let i = 0; i < edits.length; i++) {
    const edit = edits[i], target = targets[i];
    // Some hosts summarize only an older prefix, excluding retained recent owners.
    if (olderContext && !incoming.some((message) => message.id === target.message_id || message.content.some((part) =>
      (part.type === "tool-call" || part.type === "tool-result") && part.id === target.call_id))) continue;
    if (target.kind === "reasoning") {
      const owners = incoming.filter((message) => message.id === target.message_id && message.role === "assistant");
      if (owners.length !== 1) throw new Rejected("source_changed", "Reasoning ownership is ambiguous in this request.");
      const parts = owners[0].content.filter((part) => part.type === "reasoning");
      const part = parts[target.ordinal];
      if (!part || part.type !== "reasoning" || part.text !== target.text || part.encrypted) {
        throw new Rejected("source_changed", "Selected reasoning is absent, changed or opaque in this request.");
      }
      replacements.set(part, null);
      continue;
    }
    const calls = incoming.flatMap((message, index) => message.content.filter((part) => part.type === "tool-call" && part.id === target.call_id)
      .map((part) => ({ message, part, index })));
    const results = incoming.flatMap((message, index) => message.content.filter((part) => part.type === "tool-result" && part.id === target.call_id)
      .map((part) => ({ message, part, index })));
    const call = calls[0], result = results[0];
    if (calls.length !== 1 || results.length !== 1 || call.part.type !== "tool-call" || result.part.type !== "tool-result"
      || call.message.id !== target.message_id || call.message.role !== "assistant" || result.message.role !== "tool"
      || call.index >= result.index || call.part.name !== target.name || result.part.name !== target.name
      || digest(call.part.input) !== digest(target.input) || call.part.providerMetadata || result.part.providerMetadata
      || call.part.providerExecuted || result.part.providerExecuted) {
      throw new Rejected("source_changed", "Selected tool call/result pair is absent, changed or opaque in this request.");
    }
    const output = result.part.result;
    const text = output.type === "text" ? output.value : output.type === "content" && output.value.every((part) => part.type === "text")
      ? output.value.map((part) => part.type === "text" ? part.text : "").join("\n\n") : null;
    if (text !== target.text) throw new Rejected("source_changed", "Selected tool output changed in the assembled request.");
    if (edit.action === "delete-invocation") {
      replacements.set(call.part, null); replacements.set(result.part, null);
    } else replacements.set(result.part, { ...result.part, result: { type: "text", value: PRUNED } });
  }
  return incoming.flatMap((message) => {
    const content = message.content.flatMap((part) => replacements.has(part) ? replacements.get(part) ? [replacements.get(part)!] : [] : [part]);
    if (content.length === message.content.length && content.every((part, index) => part === message.content[index])) return [message];
    return content.length ? [new Message({ ...message, content })] : [];
  });
}
