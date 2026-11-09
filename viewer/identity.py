"""Source identity, independent of display order and token estimates."""
import json
from collections import Counter


def source_key(*segments):
    return json.dumps(segments, ensure_ascii=False, separators=(",", ":"))


def identify_parts(session_id, messages, parts, provenance):
    sources = {}
    units = {unit["id"]: unit for unit in provenance["units"]}
    messages_by_id = {message["id"]: message for message in messages}
    layouts = {}
    for message in messages:
        content = message.get("content", []) if message.get("type") == "assistant" else []
        layouts[message["id"]] = (
            Counter(entry.get("id") for entry in content if entry.get("type") == "tool"),
            Counter(entry.get("type") for entry in content),
        )
    for part in parts:
        message = messages_by_id[part["message_id"]]
        suffix = part["id"][len(message["id"]) + 1:]
        key, unit_key, status = None, None, message.get("status")
        if message.get("type") == "assistant":
            index = int(suffix.split(":", 1)[0])
            entry = message["content"][index]
            native_counts, type_counts = layouts[message["id"]]
            if entry.get("type") == "tool":
                native_id = entry.get("id")
                unit = units[f"{message['id']}:{index}"]
                if isinstance(native_id, str) and native_id and native_counts[native_id] == 1:
                    unit_key = source_key(session_id, message["id"], "tool", native_id)
                unit.update(source_key=unit_key, call_id=native_id, message_id=message["id"])
                status = unit["status"]
                if unit_key:
                    key = source_key(unit_key, suffix[len(str(index)) + 1:])
            elif type_counts[entry.get("type")] == 1:
                key = source_key(session_id, message["id"], entry.get("type"))
        else:
            key = source_key(session_id, message["id"], message.get("type"), suffix)
            if suffix.startswith("file:") and len(message.get("files", [])) > 1:
                key = None
        sources[part["id"]] = {"key": key, "unit_key": unit_key, "status": status}
    provenance["sources"] = sources
    provenance["checkpoints"] = [message["id"] for message in messages
                                 if message.get("type") == "compaction" and message.get("status") == "completed"]
