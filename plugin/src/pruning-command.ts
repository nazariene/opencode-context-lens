import { randomUUID } from "node:crypto";
import type { Runtime } from "./runtime.js";
import { Rejected, type Scope } from "./protocol.js";
import type { Action } from "./pruning-source.js";

const help = `Context Lens pruning — previews by default; append --apply to commit immediately.
/lens-prune list messages|tools|reasoning
/lens-prune tools [tool-name|all] [--outputs] [--min-bytes N] [--apply]
/lens-prune large [bytes, default 16384] [--outputs] [--apply]
/lens-prune reasoning [--apply]
/lens-prune range FIRST_MESSAGE_ID LAST_MESSAGE_ID [--apply]
/lens-prune summarize brief|full FIRST_MESSAGE_ID LAST_MESSAGE_ID [--apply]
/lens-prune apply PREVIEW_ID
/lens-prune restore GROUP_ID|all
/lens-prune status

Ranges are inclusive. Tools/large delete complete invocations and associated reasoning; --outputs keeps calls and arguments.
Size = UTF-8 bytes of arguments plus output, not provider tokens. Successful native compaction clears edits.
Closing a report does not apply edits.`;

export async function executePruningCommand(runtime: Runtime, scope: Scope, text: string, signal?: AbortSignal) {
  runtime.check(scope);
  signal?.throwIfAborted();
  const sessionID = scope.session_id;
  const words = text.trim().split(/\s+/).filter(Boolean), verb = words.shift() ?? "help";
  if (verb === "help" && !words.length) return help;
  if (verb === "apply") {
    if (words.length !== 1) throw new Rejected("invalid_command", "Use apply PREVIEW_ID.");
    const saved = await runtime.serialized(sessionID, () => runtime.pruning.apply({ ...scope, preview_id: words[0], operation_id: `command_apply_${words[0]}` }, signal));
    return `Saved policy revision ${saved.revision}: ${saved.edits.length} active edits.\n/lens-prune status`;
  }
  const status = await runtime.serialized(sessionID, () => runtime.pruning.inspect(scope));
  if (verb === "status" && !words.length) return `Policy revision ${status.revision}: ${status.edits.length} active edits.\n`
    + [...new Set(status.edits.map((edit) => edit.group_id))].map((group) => `${status.edits.filter((edit) => edit.group_id === group).length} edits [${group}]`).join("\n")
    + (status.last_compaction ? "\nReset after successful native compaction." : "") + (status.reason ? `\n${status.reason}` : "");
  if (verb === "restore") {
    if (words.length !== 1) throw new Rejected("invalid_command", "Use restore GROUP_ID|all.");
    const groups = words[0] === "all" ? [...new Set(status.edits.map((edit) => edit.group_id))] : words;
    if (!groups.length) return "No saved edits to restore.";
    const saved = await runtime.serialized(sessionID, () => runtime.pruning.restore({ ...scope, revision: status.revision, group_ids: groups, operation_id: randomUUID() }, signal));
    return `Restored ${groups.length} groups. Policy revision ${saved.revision}.`;
  }
  if (verb === "list") {
    if (words.length > 1 || words[0] && !["messages", "tools", "reasoning"].includes(words[0])) throw new Rejected("invalid_command", "Use list messages|tools|reasoning.");
    const kind = words[0] === "tools" ? "tool" : words[0] === "reasoning" ? "reasoning" : "message";
    return status.targets.filter((target) => target.kind === kind).map((target) => `${target.title} [${target.call_id ?? target.message_id}] · ${target.bytes} bytes`
      + `${target.reason ? ` · ${target.reason}` : target.pinned ? " · pinned" : target.edit ? " · edited" : target.summary_conflict ? " · summary conflict" : ""}`).join("\n") || status.reason || "No items.";
  }
  if (status.reason || !status.source_guard) throw new Rejected("pruning_unavailable", status.reason ?? "Source unavailable.");
  const immediate = words.includes("--apply"), outputs = words.includes("--outputs");
  const args = words.filter((word) => word !== "--apply" && word !== "--outputs");
  if (words.filter((word) => word === "--apply").length > 1 || words.filter((word) => word === "--outputs").length > 1) throw new Rejected("invalid_command", "Duplicate option.");
  let action: Action, ids: string[], excluded = 0;
  if (["range", "summarize"].includes(verb)) {
    const style = verb === "summarize" ? args.shift() : null;
    if (outputs || args.length !== 2 || verb === "summarize" && !["brief", "full"].includes(style!)) throw new Rejected("invalid_command", "Use range FIRST LAST or summarize brief|full FIRST LAST.");
    action = style === "brief" ? "summarize-brief" : style === "full" ? "summarize-full" : "delete-range";
    ids = args.map((id) => {
      const target = status.targets.find((target) => target.kind === "message" && target.message_id === id);
      if (!target) throw new Rejected("invalid_selection", `Unknown message [${id}]. Use list messages.`);
      return target.id;
    });
  } else if (["tools", "large", "reasoning"].includes(verb)) {
    action = verb === "reasoning" ? "remove-reasoning" : outputs ? "prune-result" : "delete-invocation";
    let min = verb === "large" ? 16384 : 0, name = "all";
    if (verb === "large" && args.length) min = Number(args.shift());
    if (verb === "tools") {
      if (args[0] && !args[0].startsWith("--")) name = args.shift()!;
      if (args[0] === "--min-bytes" && args.length === 2) { args.shift(); min = Number(args.shift()); }
    }
    if (args.length || !Number.isSafeInteger(min) || min < 0 || verb === "reasoning" && outputs) throw new Rejected("invalid_command", "Invalid selection/options. Use /lens-prune help.");
    const candidates = status.targets.filter((target) => target.kind === (verb === "reasoning" ? "reasoning" : "tool")
      && (name === "all" || target.title === name) && target.bytes >= min);
    const eligible = (target: typeof candidates[number]) => !target.reason && !target.pinned && !target.edit && !target.summary_conflict;
    const targets = candidates.filter((target) => eligible(target) && (action !== "delete-invocation"
      || status.targets.filter((part) => part.kind === "reasoning" && part.message_id === target.message_id).every(eligible)));
    excluded = candidates.length - targets.length; ids = targets.map((target) => target.id);
    if (!ids.length) return `No eligible matches; ${excluded} protected/unsupported/edited matches excluded.`;
  } else throw new Rejected("invalid_command", "Unknown command. Use /lens-prune help.");
  if (ids.length > 512) throw new Rejected("size_limit", "Selection exceeds 512 targets. Narrow the tool name/size or use dashboard selection.");
  const preview = await runtime.pruning.preview({ ...scope, revision: status.revision, source_guard: status.source_guard, action, target_ids: ids }, signal);
  if (immediate) {
    const saved = await runtime.serialized(sessionID, () => runtime.pruning.apply({ ...scope, preview_id: preview.preview_id, operation_id: `command_apply_${preview.preview_id}` }, signal));
    return `Applied ${preview.rows.length} edits; ${excluded} matches excluded. Policy revision ${saved.revision}.\n/lens-prune status`;
  }
  return `Preview only: ${preview.rows.length} edits; ${excluded} matches excluded. Expires in five minutes.\nApply: /lens-prune apply ${preview.preview_id}\n\n`
    + preview.rows.map((row) => `${row.title} · ${row.action}${row.expanded ? " · included by range/pair closure" : ""}\nBEFORE\n${row.before}\nAFTER\n${row.after || "(omitted)"}`).join("\n\n");
}
