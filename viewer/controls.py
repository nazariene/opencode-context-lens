import uuid

from .history import ReviewError
from .identity import source_key


class Pins:
    def __init__(self, run_id, limit=4096):
        self.run_id = run_id
        self.limit = limit
        self.sessions = {}

    def version(self, session_id):
        return self.sessions.get(session_id, {}).get("version", 0)

    def require_version(self, session_id, version):
        if self.version(session_id) != version:
            raise ReviewError(409, "pins_changed", "Pins changed. Refresh the protection state.")

    def anchors(self, record):
        units = {part_id: unit for unit in record.provenance["units"] for part_id in unit["part_ids"]}
        anchors = {}
        for part in record.context["parts"]:
            unit = units.get(part["id"])
            source = record.provenance["sources"][part["id"]]
            key = unit.get("source_key") if unit else source["key"]
            if not key:
                key = source_key(self.run_id, record.context["session"]["id"], record.control_id,
                                 unit["id"] if unit else part["id"])
            anchors[part["id"]] = {"anchor": key, "kind": "unit" if unit else "part",
                                    "unit_id": unit["id"] if unit else None, "label": part["title"][:220]}
        return anchors

    def describe(self, session_id, record):
        session = self.sessions.get(session_id, {"version": 0, "pins": {}})
        anchors = self.anchors(record) if record else {}
        pins = []
        for pin_id, pin in session["pins"].items():
            parts = [part_id for part_id, source in anchors.items() if source["anchor"] == pin["anchor"]]
            pins.append({"id": pin_id, "label": pin["label"], "kind": pin["kind"],
                         "resolved": bool(parts), "part_ids": parts,
                         "unit_id": anchors[parts[0]]["unit_id"] if parts else None})
        return {"run_id": self.run_id, "session_id": session_id, "pin_version": session["version"], "pins": pins}

    def additions(self, session_id, record, part_ids, version):
        self.require_version(session_id, version)
        anchors = self.anchors(record)
        if not part_ids or set(part_ids) - anchors.keys():
            raise ReviewError(422, "invalid_pins", "Choose current context parts to pin.")
        session = self.sessions.get(session_id, {"version": 0, "pins": {}})
        known = {pin["anchor"] for pin in session["pins"].values()}
        additions = {anchors[part_id]["anchor"]: anchors[part_id] for part_id in part_ids
                     if anchors[part_id]["anchor"] not in known}
        if sum(len(entry["pins"]) for entry in self.sessions.values()) + len(additions) > self.limit:
            raise ReviewError(429, "pin_capacity", "Pin limit reached. Unpin content before adding protection.")
        if session_id not in self.sessions and len(self.sessions) >= self.limit:
            raise ReviewError(429, "control_capacity", "Control-state session limit reached for this run.")
        return session, additions

    def add(self, session_id, record, part_ids, version):
        session, additions = self.additions(session_id, record, part_ids, version)
        if additions:
            session["pins"].update({"pin_" + uuid.uuid4().hex: pin for pin in additions.values()})
            session["version"] += 1
            self.sessions[session_id] = session
        return self.describe(session_id, record)

    def remove(self, session_id, pin_id, version, record):
        self.require_version(session_id, version)
        session = self.sessions.get(session_id)
        if not session or pin_id not in session["pins"]:
            raise ReviewError(404, "pin_missing", "Pin is no longer present.")
        del session["pins"][pin_id]
        session["version"] += 1
        return self.describe(session_id, record)

    def project(self, session_id, record):
        state = self.describe(session_id, record)
        protected = {pin["unit_id"] for pin in state["pins"] if pin["unit_id"]}
        return dict(record.analysis, run_id=self.run_id, pin_version=state["pin_version"],
                    units=[dict(unit, pinned=unit["id"] in protected,
                                selectable=unit["eligible"] and unit["id"] not in protected)
                           for unit in record.analysis["units"]])

    def validate_selection(self, session_id, record, unit_ids):
        selected = set(unit_ids)
        pinned = {pin["unit_id"] for pin in self.describe(session_id, record)["pins"] if pin["unit_id"]}
        if selected & pinned:
            raise ReviewError(422, "invalid_selection", "Selection contains pinned tool invocations.",
                              pinned_unit_ids=sorted(selected & pinned))
