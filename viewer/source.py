"""Protocol-v1 source bindings shared with plugin/src/source.ts."""
import hashlib
import math
from collections import Counter

import rfc8785

from .history import ReviewError

MESSAGE_FIELDS = ("id", "type", "text", "name", "description", "files", "command", "output",
                  "status", "summary", "recent", "providerContext", "providerState", "native")
CONTENT_FIELDS = ("type", "id", "name", "text", "state", "executed", "providerState", "providerResultState", "native")
STATE_FIELDS = ("status", "input", "content", "error", "reasoningEncryptedContent")


def representable(value):
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if not math.isfinite(value) or (value == int(value) and abs(value) > 9007199254740991):
            raise ValueError("Source has a number outside the interoperable JSON range.")
    elif isinstance(value, list):
        for entry in value:
            representable(entry)
    elif isinstance(value, dict):
        for entry in value.values():
            representable(entry)


def digest(value):
    try:
        representable(value)
        return hashlib.sha256(rfc8785.dumps(value)).hexdigest()
    except (ValueError, OverflowError) as error:
        raise ReviewError(422, "unsupported_source", "Source cannot be bound using canonical JSON.") from error


def source_record(session, messages):
    records = []
    for message in messages:
        record = {key: message[key] for key in MESSAGE_FIELDS if key in message}
        if message.get("type") == "compaction" and message.get("metadata"):
            retained = {key: message["metadata"][key] for key in ("recent", "keepID") if key in message["metadata"]}
            if retained:
                record["metadata"] = retained
        if "content" in message:
            record["content"] = []
            for content in message["content"]:
                part = {key: content[key] for key in CONTENT_FIELDS if key in content}
                if "state" in content:
                    part["state"] = {key: content["state"][key] for key in STATE_FIELDS if key in content["state"]}
                record["content"].append(part)
        records.append(record)
    return {"protocol": 1, "session_id": session["id"], "location": session.get("location"),
            "model": session.get("model"), "messages": records}


def unit_record(session_id, message_id, call_id, name, tool_input, content):
    return {"protocol": 1, "session_id": session_id, "message_id": message_id, "call_id": call_id,
            "name": name, "status": "completed", "input": tool_input, "content": content}


def source_units(session, messages):
    counts = Counter(content.get("id") for message in messages for content in message.get("content", [])
                     if content.get("type") == "tool")
    units = {}
    for message in messages:
        for index, call in enumerate(message.get("content", [])):
            if call.get("type") != "tool":
                continue
            state = call.get("state") or {}
            if (not call.get("id") or counts[call["id"]] != 1 or state.get("status") != "completed"
                    or state.get("error") or not state.get("content")
                    or any(entry.get("type") != "text" for entry in state["content"])
                    or message.get("native") is not None or call.get("native") is not None
                    or call.get("executed") or call.get("providerState") or call.get("providerResultState")
                    or call["name"].split(".")[-1] == "skill"):
                continue
            unit_id = f"{message['id']}:{index}"
            units[unit_id] = {"unit_id": unit_id, "message_id": message["id"], "call_id": call["id"],
                              "name": call["name"], "input": state["input"], "content": state["content"],
                              "fingerprint": digest(unit_record(session["id"], message["id"], call["id"],
                                                              call["name"], state["input"], state["content"]))}
    return units


def wrapped_summary(unit, summary):
    return f"Context Lens summary of {unit['name']} [{unit['call_id']}]:\n{summary}"


def validate_summaries(ids, summaries):
    if set(ids) != summaries.keys():
        raise ReviewError(422, "invalid_summaries", "Provide exactly one summary for every selected unit.")
    for text in summaries.values():
        try:
            size = len(text.encode()) if isinstance(text, str) else 0
        except UnicodeError as error:
            raise ReviewError(422, "invalid_summaries", "Summary text must contain valid Unicode.") from error
        if not isinstance(text, str) or not text.strip() or size > 16384:
            raise ReviewError(422, "invalid_summaries", "Each summary must be nonempty and at most 16 KiB.")
    if sum(len(text.encode()) for text in summaries.values()) > 49152:
        raise ReviewError(413, "size_limit", "Combined summaries exceed 48 KiB.")
