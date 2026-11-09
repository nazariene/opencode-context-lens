import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field

from .context import serialized


class ReviewError(ValueError):
    def __init__(self, status, code, message, **details):
        super().__init__(message)
        self.status = status
        self.detail = {"code": code, "message": message, **details}


def text_free(context):
    return dict(context, parts=[{key: value for key, value in part.items() if key != "text"}
                                for part in context["parts"]])


@dataclass
class Observation:
    id: str
    session_id: str
    payload: tuple
    first_observed: int
    last_observed: int
    last_monotonic: float
    gap: bool
    compaction: bool
    reported: dict | None

    def metadata(self):
        return {"snapshot_id": self.id, "session_id": self.session_id,
                "first_observed": self.first_observed, "last_observed": self.last_observed,
                "gap": self.gap, "compaction": self.compaction, "reported": self.reported}


@dataclass
class SessionHistory:
    observations: list = field(default_factory=list)
    evicted: int = 0
    skipped: int = 0
    last_monotonic: float | None = None
    checkpoints: set = field(default_factory=set)
    last_revision: str | None = None


class History:
    def __init__(self, settings):
        self.settings = settings
        self.run_id = "run_" + uuid.uuid4().hex
        self.sequence = 0
        self.sessions = OrderedDict()
        self.observations = OrderedDict()
        self.payloads = {}
        self.bytes = 0
        self.evicted_sessions = 0

    def require_run(self, run_id):
        if run_id != self.run_id:
            raise ReviewError(409, "run_changed", "Dashboard restarted. Refresh to begin a new run.")

    def _metadata_bytes(self, observation):
        return len(serialized(observation.metadata()).encode())

    def _remove(self, snapshot_id):
        observation = self.observations.pop(snapshot_id)
        session = self.sessions[observation.session_id]
        session.observations.remove(snapshot_id)
        session.evicted += 1
        payload = self.payloads[observation.payload]
        payload[2] -= 1
        self.bytes -= self._metadata_bytes(observation)
        if not payload[2]:
            self.bytes -= payload[1]
            del self.payloads[observation.payload]

    def observe(self, record, now=None, monotonic=None):
        now = int(time.time() * 1000) if now is None else now
        monotonic = time.monotonic() if monotonic is None else monotonic
        context = record.context
        session_id = context["session"]["id"]
        if session_id not in self.sessions:
            if len(self.sessions) >= self.settings.history_sessions:
                oldest_id, oldest = next(iter(self.sessions.items()))
                for snapshot_id in list(oldest.observations):
                    self._remove(snapshot_id)
                del self.sessions[oldest_id]
                self.evicted_sessions += 1
            self.sessions[session_id] = SessionHistory()
        session = self.sessions[session_id]
        self.sessions.move_to_end(session_id)
        previous = self.observations.get(session.observations[-1]) if session.observations else None
        same_observation = session.last_revision == context["revision"]
        session.last_revision = context["revision"]
        gap = session.last_monotonic is not None and (
            monotonic - session.last_monotonic > self.settings.refresh_seconds * 2)
        session.last_monotonic = monotonic
        checkpoints = set(record.provenance["checkpoints"])
        known_checkpoints = session.checkpoints | {
            checkpoint for observation_id in session.observations
            for checkpoint in self.payloads[self.observations[observation_id].payload][0].provenance["checkpoints"]}
        compaction = bool(checkpoints - known_checkpoints)
        session.checkpoints = checkpoints
        if previous and same_observation and previous.payload[1] == context["revision"]:
            self.bytes -= self._metadata_bytes(previous)
            previous.last_observed = now
            previous.last_monotonic = monotonic
            previous.reported = context.get("reported")
            previous.gap |= gap
            self.bytes += self._metadata_bytes(previous)
            while self.bytes > self.settings.history_max_bytes and self.observations:
                self._remove(next(iter(self.observations)))
            return previous.id if previous.id in self.observations else None
        self.sequence += 1
        key = (session_id, context["revision"])
        observation = Observation(f"snapshot_{self.sequence}", session_id, key, now, now,
                                  monotonic, gap, compaction, context.get("reported"))
        metadata_bytes = self._metadata_bytes(observation)
        if record.payload_bytes + metadata_bytes > self.settings.history_max_bytes:
            session.skipped += 1
            return None
        if key not in self.payloads:
            self.payloads[key] = [record, record.payload_bytes, 0]
            self.bytes += record.payload_bytes
        self.payloads[key][2] += 1
        self.bytes += metadata_bytes
        self.observations[observation.id] = observation
        session.observations.append(observation.id)
        while len(session.observations) > self.settings.history_snapshots_per_session:
            self._remove(session.observations[0])
        while self.bytes > self.settings.history_max_bytes:
            self._remove(next(iter(self.observations)))
        return observation.id if observation.id in self.observations else None

    def get(self, session_id, run_id, snapshot_id):
        self.require_run(run_id)
        observation = self.observations.get(snapshot_id)
        if observation and observation.session_id != session_id:
            raise ReviewError(400, "wrong_session", "Choose snapshots from the same session.")
        if not observation:
            raise ReviewError(410, "history_unavailable", "Historical snapshot is no longer retained.")
        return observation, self.payloads[observation.payload][0]

    def summary(self, session_id):
        session = self.sessions.get(session_id)
        observations = []
        for snapshot_id in session.observations if session else []:
            observation = self.observations[snapshot_id]
            context = self.payloads[observation.payload][0].context
            summary = {key: context[key] for key in ("revision", "tokens", "categories", "unknown_count",
                                                     "window", "window_percent", "tokenizer", "model")}
            summary.update(observation.metadata())
            summary["delta"] = context["tokens"] - observations[-1]["tokens"] if observations else None
            observations.append(summary)
        return {"run_id": self.run_id, "session_id": session_id, "observations": observations,
                "evicted": session.evicted if session else 0, "skipped": session.skipped if session else 0,
                "evicted_sessions": self.evicted_sessions, "accounted_bytes": self.bytes,
                "max_bytes": self.settings.history_max_bytes}
