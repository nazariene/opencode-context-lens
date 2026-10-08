import hashlib
import json
import math
from collections import Counter
from functools import lru_cache

import tiktoken

CATEGORIES = {
    "user": ("Your messages", "#7c9cff"),
    "assistant": ("Assistant replies", "#a78bfa"),
    "tools": ("Tool results", "#45d4ba"),
    "calls": ("Tool calls", "#73b7eb"),
    "instructions": ("System & instructions", "#f3bd69"),
    "skills": ("Skills", "#e895cf"),
    "reasoning": ("Visible reasoning", "#dca279"),
    "compaction": ("Compaction checkpoint", "#d5cd8a"),
    "attachments": ("Attachments", "#94a3b8"),
    "other": ("Other context", "#b6c3d2"),
}


class TokenCounter:
    def __init__(self):
        try:
            self.encoding = tiktoken.get_encoding("o200k_base")
        except (OSError, ValueError):
            self.encoding = None
        self.method = "o200k_base text estimate" if self.encoding else "UTF-8 bytes / 4 estimate (tokenizer unavailable)"

    def count(self, text: str) -> int:
        return count_text(text, self.encoding)


@lru_cache(maxsize=2048)
def count_text(text: str, encoding) -> int:
    if encoding:
        return len(encoding.encode(text, disallowed_special=()))
    return math.ceil(len(text.encode("utf-8")) / 4)


def serialized(value) -> str:
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def percentage(value: int, total: int | None):
    return round(value / total * 100, 2) if total else None


def build_context(session: dict, messages: list[dict], model: dict | None, counter: TokenCounter) -> dict:
    parts = []
    excluded = Counter()
    opaque = 0

    def add(message, suffix, category, title, text, note=None, unknown=False):
        if not text and not unknown:
            return
        text = str(text or "")
        parts.append({
            "id": f"{message['id']}:{suffix}", "message_id": message["id"],
            "category": category, "title": title, "text": text,
            "tokens": None if unknown else counter.count(text),
            "bytes": len(text.encode("utf-8")), "note": note,
            "created": message.get("time", {}).get("created"),
            "preview": " ".join(text[:400].split())[:220],
        })

    def attachment(message, suffix, file):
        label = file.get("name") or file.get("filename") or file.get("mime") or "Attachment"
        # Never tokenize base64 as if it were natural-language context.
        description = {key: file[key] for key in ("name", "filename", "mime", "description") if key in file}
        add(message, suffix, "attachments", label, serialized(description),
            "Media token usage is provider-dependent and is not exposed by this API.", unknown=True)

    for message in messages:
        kind = message.get("type", "unknown")
        if kind in ("agent-switched", "model-switched", "location-switched", "idle"):
            excluded[kind] += 1
            continue
        if kind == "assistant":
            for index, content in enumerate(message.get("content", [])):
                suffix = str(index)
                content_type = content.get("type")
                if content_type in ("text", "reasoning"):
                    category = "assistant" if content_type == "text" else "reasoning"
                    state = content.get("state") or {}
                    hidden = content_type == "reasoning" and bool(state.get("reasoningEncryptedContent"))
                    opaque += int(hidden)
                    add(message, suffix, category, "Assistant reply" if category == "assistant" else "Visible reasoning",
                        content.get("text"), "Encrypted reasoning is not included in this text estimate." if hidden else None,
                        unknown=hidden and not content.get("text"))
                elif content_type == "tool":
                    state = content.get("state") or {}
                    name = content.get("name", "Tool")
                    tool_input = state.get("input", {})
                    add(message, suffix + ":call", "calls", f"{name} · input", serialized(tool_input),
                        f"Status: {state.get('status', 'unknown')}")
                    category = "skills" if name.split(".")[-1] == "skill" else "tools"
                    for result_index, output in enumerate(state.get("content", [])):
                        result_suffix = f"{suffix}:result:{result_index}"
                        if output.get("type") == "text":
                            add(message, result_suffix, category, f"{name} · result", output.get("text"))
                        elif output.get("type") == "file":
                            attachment(message, result_suffix, output)
                        else:
                            add(message, result_suffix, "other", f"{name} · {output.get('type', 'result')}",
                                "Unsupported tool content format", unknown=True)
                    if state.get("error"):
                        add(message, suffix + ":error", "tools", f"{name} · error", serialized(state["error"]))
                else:
                    add(message, suffix, "other", f"Unknown assistant part: {content_type}",
                        "Unsupported content format", unknown=True)
        elif kind == "compaction":
            if message.get("status") != "completed":
                excluded["unfinished compaction"] += 1
                continue
            add(message, "summary", "compaction", "Compaction summary", message.get("summary"))
            add(message, "recent", "compaction", "Retained recent context", message.get("recent"))
            if message.get("providerContext"):
                opaque += 1
                add(message, "provider", "compaction", "Provider-native checkpoint", "Provider-specific context retained",
                    "The provider-native checkpoint may replace the readable summary. Its token size is unknown.", True)
        elif kind == "shell":
            output = message.get("output") or {}
            text = output.get("output", "") if isinstance(output, dict) else output
            add(message, "shell", "tools", "Shell command", f"Shell command: {message.get('command', '')}\n\n{text}")
        else:
            category = {"user": "user", "system": "instructions", "synthetic": "instructions", "skill": "skills"}.get(kind, "other")
            title = message.get("description") or message.get("name") or CATEGORIES[category][0]
            add(message, "text", category, title, message.get("text"), unknown=category == "other")
            for index, file in enumerate(message.get("files", [])):
                attachment(message, f"file:{index}", file)

    total = sum(part["tokens"] or 0 for part in parts)
    limit = (model or {}).get("limit", {}).get("context") or None
    categories = []
    for key, (label, color) in CATEGORIES.items():
        selected = [part for part in parts if part["category"] == key]
        if not selected:
            continue
        tokens = sum(part["tokens"] or 0 for part in selected)
        categories.append({"id": key, "name": label, "color": color, "tokens": tokens,
                           "count": len(selected), "unknown": sum(part["tokens"] is None for part in selected),
                           "percent": percentage(tokens, total), "window_percent": percentage(tokens, limit)})
    for index, part in enumerate(parts):
        part.update(order=index, percent=percentage(part["tokens"], total) if part["tokens"] is not None else None,
                    window_percent=percentage(part["tokens"], limit) if part["tokens"] is not None else None)

    # Session.tokens is cumulative spend, not the size of the current context.
    latest = next((message for message in reversed(messages)
                   if message.get("type") == "assistant" and message.get("tokens")
                   and message.get("time", {}).get("completed")), None)
    reported = None
    if latest:
        usage = latest["tokens"]
        cache = usage.get("cache") or {}
        input_tokens = usage.get("input", 0) + cache.get("read", 0) + cache.get("write", 0)
        model_ref = latest.get("model") or {}
        same_model = (model_ref.get("id"), model_ref.get("providerID")) == (
            (session.get("model") or {}).get("id"), (session.get("model") or {}).get("providerID"))
        reported = {"input": input_tokens, "uncached_input": usage.get("input", 0),
                    "cache_read": cache.get("read", 0), "cache_write": cache.get("write", 0),
                    "output": usage.get("output", 0), "reasoning": usage.get("reasoning", 0),
                    "percent": percentage(input_tokens, limit) if same_model else None,
                    "message_id": latest["id"], "model": model_ref, "same_model": same_model,
                    "completed": latest["time"]["completed"]}
    revision = hashlib.sha256(serialized(parts).encode()).hexdigest()[:16]
    return {
        "session": {key: session[key] for key in ("id", "title", "location", "model", "time", "parentID") if key in session},
        "model": {key: model[key] for key in ("id", "providerID", "name", "limit") if key in model} if model else None,
        "revision": revision, "parts": parts, "categories": categories,
        "tokens": total, "window": limit, "window_percent": percentage(total, limit),
        "message_count": len(messages), "part_count": len(parts),
        "unknown_count": sum(part["tokens"] is None for part in parts), "opaque_count": opaque,
        "excluded": dict(excluded), "reported": reported, "tokenizer": counter.method,
        "scope": "Active API context after compaction. Sizes estimate visible text, not the complete provider request. "
                 "Base system prompts, tool definitions, protocol overhead, media and encrypted reasoning are not fully itemized by OpenCode.",
    }
