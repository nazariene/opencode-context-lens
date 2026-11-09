"""Bounded review drafts; original source records are independent of history eviction."""
import time
import uuid
from dataclasses import dataclass

from .analysis import preview_selection
from .context import percentage, serialized
from .history import ReviewError
from .source import digest, validate_summaries, wrapped_summary


@dataclass
class Draft:
    id: str
    session_id: str
    revision: str
    pin_version: int
    source_guard: str
    location: str
    units: list
    source_parts: list
    model: dict | None
    created: float
    version: int = 1
    state: str = "draft"
    summaries: dict | None = None
    preview: dict | None = None
    job_id: str | None = None
    instance_id: str | None = None
    reason: str | None = None
    estimated_input: int | None = None
    pending_action: str | None = None

    def payload(self):
        return {"units": self.units, "parts": self.source_parts, "summaries": self.summaries,
                "source_guard": self.source_guard, "location": self.location, "model": self.model,
                "revision": self.revision}

    def descriptors(self):
        return [{key: unit[key] for key in ("unit_id", "message_id", "call_id", "fingerprint")}
                for unit in self.units]


class Drafts:
    def __init__(self, run_id, pins):
        self.run_id = run_id
        self.pins = pins
        self.drafts = {}
        self.operations = {}
        self.max_count = 32
        self.max_bytes = 16 * 1024 * 1024

    def expire(self):
        for draft_id, draft in list(self.drafts.items()):
            if time.monotonic() - draft.created >= 1800 and draft.state not in ("generating", "active", "pending"):
                del self.drafts[draft_id]
        for key, (_, draft_id) in list(self.operations.items()):
            if draft_id not in self.drafts:
                del self.operations[key]

    def get(self, session_id, run_id, draft_id, version=None):
        if run_id != self.run_id:
            raise ReviewError(409, "run_changed", "Dashboard restarted. Review again.")
        self.expire()
        draft = self.drafts.get(draft_id)
        if not draft or draft.session_id != session_id:
            raise ReviewError(404, "draft_missing", "Draft is no longer retained for this session.")
        if version is not None and draft.version != version:
            raise ReviewError(409, "draft_changed", "Draft changed. Review the current version.")
        return draft

    def existing(self, session_id, operation_id, body):
        self.expire()
        previous = self.operations.get((session_id, operation_id))
        if previous:
            if previous[0] != digest(body):
                raise ReviewError(409, "operation_conflict", "Operation ID reused with different content.")
            return self.drafts[previous[1]]
        return None

    def capacity(self, draft, summaries):
        payload = dict(draft.payload(), summaries=summaries)
        size = len(serialized(payload).encode())
        size += sum(len(serialized(other.payload()).encode()) for other in self.drafts.values() if other.id != draft.id)
        if size > self.max_bytes or (draft.id not in self.drafts and len(self.drafts) >= self.max_count):
            raise ReviewError(429, "draft_capacity", "Draft capacity reached. Discard inactive drafts first.")

    def create(self, session_id, record, body):
        self.pins.require_version(session_id, body["pin_version"])
        self.pins.validate_selection(session_id, record, body["unit_ids"])
        preview_selection(record.context, record.analysis, body["unit_ids"])
        selected = set(body["unit_ids"])
        ids = [unit["id"] for unit in record.provenance["units"] if unit["id"] in selected]
        if not ids or len(ids) > 128:
            raise ReviewError(422, "invalid_selection", "Select between 1 and 128 complete units.")
        if record.source_error or selected - record.source_units.keys():
            raise ReviewError(422, "unsupported_source", record.source_error or "Selection contains ambiguous or unsupported native sources.")
        summaries = body.get("summaries")
        if body["mode"] == "manual":
            validate_summaries(ids, summaries)
        units = [record.source_units[unit_id] for unit_id in ids]
        selected_parts = {part_id for unit in record.analysis["units"] if unit["id"] in selected for part_id in unit["part_ids"]}
        draft = Draft("draft_" + uuid.uuid4().hex, session_id, record.context["revision"], body["pin_version"],
                      record.source_guard, record.context["session"]["location"]["directory"], units,
                      [part for part in record.context["parts"] if part["id"] in selected_parts],
                      body.get("model") or record.context["session"].get("model"), time.monotonic(), summaries=summaries)
        self.capacity(draft, summaries)
        self.drafts[draft.id] = draft
        self.operations[(session_id, body["operation_id"])] = (digest(body), draft.id)
        return draft

    def validate_current(self, draft, record):
        if draft.revision != record.context["revision"] or draft.source_guard != record.source_guard:
            raise ReviewError(409, "source_changed", "Original source changed. Create a new draft.")
        self.pins.require_version(draft.session_id, draft.pin_version)
        self.pins.validate_selection(draft.session_id, record, [unit["unit_id"] for unit in draft.units])

    def describe(self, draft, record):
        stale = None
        if record:
            try:
                self.validate_current(draft, record)
            except ReviewError as error:
                stale = str(error)
        else:
            stale = "Refresh live context before previewing this draft."
        return {"run_id": self.run_id, "session_id": draft.session_id, "draft_id": draft.id,
                "revision": draft.revision, "pin_version": draft.pin_version, "draft_version": draft.version,
                "state": draft.state, "stale": stale, "reason": draft.reason, "summaries": draft.summaries,
                "pending_action": draft.pending_action,
                "model": draft.model, "estimated_input": draft.estimated_input, "actual_usage": None,
                "job_id": draft.job_id, "instance_id": draft.instance_id, "units": draft.descriptors(),
                "parts": draft.source_parts, "preview": draft.preview}

    def edit(self, draft, summaries):
        if draft.state in ("active", "pending", "generating"):
            raise ReviewError(409, "draft_busy", "Cancel generation or deactivate the bundle before editing.")
        validate_summaries([unit["unit_id"] for unit in draft.units], summaries)
        self.capacity(draft, summaries)
        draft.summaries = summaries
        draft.version += 1
        draft.preview = None
        draft.state, draft.reason = "draft", None

    def edit_after_generation(self, draft, summaries):
        validate_summaries([unit["unit_id"] for unit in draft.units], summaries)
        self.capacity(draft, summaries)
        draft.summaries, draft.state, draft.reason = summaries, "draft", None
        draft.version += 1
        draft.preview = None

    def preview(self, draft, record, counter):
        self.validate_current(draft, record)
        if draft.state != "draft" or draft.summaries is None:
            raise ReviewError(409, "draft_unavailable", "Complete and review every summary first.")
        selected = sum(part["tokens"] for part in draft.source_parts)
        replacement = sum(counter.count(wrapped_summary(unit, draft.summaries[unit["unit_id"]])) for unit in draft.units)
        context = record.context
        projected = context["tokens"] - selected + replacement
        return {"run_id": self.run_id, "session_id": draft.session_id, "draft_id": draft.id,
                "draft_version": draft.version, "pin_version": draft.pin_version, "revision": draft.revision,
                "before_visible_tokens": context["tokens"], "selected_source_tokens": selected,
                "replacement_tokens": replacement, "projected_visible_tokens": projected,
                "estimated_savings": selected - replacement, "window_tokens": context["window"],
                "projected_window_percent": percentage(projected, context["window"]),
                "unknown_count": context["unknown_count"], "tokenizer": context["tokenizer"],
                "mode": "runtime-projection", "provider_savings_verified": False}
