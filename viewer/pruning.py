"""Relay manual edit intent to the authoritative companion plugin."""
import asyncio

from .client import OpenCodeError
from .history import ReviewError


class PruningControls:
    def __init__(self, replacements):
        self.replacements = replacements
        self.protections = {}

    async def connection(self, record, required=True):
        capability = await self.replacements.capabilities(record)
        if capability.get("pruning") != 1:
            if required:
                raise ReviewError(503, "pruning_unavailable", "This companion plugin does not support manual pruning. Rebuild and reload it.")
            return None
        session = record.context["session"]
        return session["location"]["directory"], self.replacements.scope(session["id"], capability["instance_id"])

    async def inspect(self, session_id, record):
        try:
            connection = await self.connection(record)
            location, scope = connection
            state = await self.replacements.rpc(location, "pruningInspect", scope)
            if state["source_guard"] is not None and state["source_guard"] != record.source_guard:
                raise ReviewError(409, "source_changed", "Native context changed. Refresh the dashboard snapshot.")
            pins = self.replacements.pins.describe(session_id, record)
            part_ids = {part for pin in pins["pins"] for part in pin["part_ids"]}
            if state["source_guard"] is not None:
                await self.mirror(connection, state["targets"], part_ids, pins["pin_version"])
            for target in state["targets"]:
                target["pinned"] = target["pinned"] or bool(part_ids.intersection(target["part_ids"]))
            return dict(state, available=True, run_id=self.replacements.run_id, snapshot_revision=record.context["revision"],
                        pin_version=pins["pin_version"], instance_id=scope["instance_id"])
        except (ReviewError, OpenCodeError) as error:
            return {"available": False, "reason": str(error), "run_id": self.replacements.run_id,
                    "session_id": session_id, "snapshot_revision": record.context["revision"]}

    async def mirror(self, connection, targets, part_ids, version):
        location, scope = connection
        target_ids = [target["id"] for target in targets if set(target["part_ids"]) & set(part_ids)]
        body = dict(scope, target_ids=target_ids, pin_version=version)
        if len(self.protections) >= 4096 and scope["session_id"] not in self.protections:
            raise ReviewError(429, "capacity", "Pruning protection session limit reached.")
        await self.replacements.rpc(location, "pruningProtect", body)
        self.protections[scope["session_id"]] = (location, body)

    async def protect(self, session_id, record, part_ids, version):
        # Existing pins also work with an older/read-only companion.
        try:
            connection = await self.connection(record, required=False)
        except (ReviewError, OpenCodeError):
            if session_id in self.protections:
                raise
            return
        if connection is None:
            return
        location, scope = connection
        state = await self.replacements.rpc(location, "pruningInspect", scope)
        if state["source_guard"] != record.source_guard:
            raise ReviewError(409, "source_changed", "Context changed before protection. Refresh and retry.")
        await self.mirror(connection, state["targets"], part_ids, version)

    async def preview(self, session_id, body):
        async with self.replacements.locked(session_id):
            record = self.replacements.retained(session_id, body["snapshot_revision"])
            self.replacements.pins.require_version(session_id, body["pin_version"])
            status = await self.inspect(session_id, record)
            if not status["available"]:
                raise ReviewError(409, "pruning_unavailable", status["reason"])
            if body["instance_id"] != status["instance_id"]:
                raise ReviewError(409, "instance_changed", "Plugin restarted. Refresh before previewing.")
            location = record.context["session"]["location"]["directory"]
        request = {key: body[key] for key in ("run_id", "instance_id", "revision", "source_guard", "target_ids", "action")}
        request["session_id"] = session_id
        preview = await self.replacements.rpc(location, "pruningPreview", request)
        async with self.replacements.locked(session_id):
            self.replacements.pins.require_version(session_id, body["pin_version"])
            self.replacements.retained(session_id, body["snapshot_revision"])
        counter = self.replacements.counter()
        before = sum(counter.count(row["before"]) for row in preview["rows"])
        after = sum(counter.count(row["after"]) for row in preview["rows"])
        return dict(preview, run_id=body["run_id"], session_id=session_id, pin_version=body["pin_version"],
                    snapshot_revision=body["snapshot_revision"], instance_id=body["instance_id"],
                    before_tokens=before, after_tokens=after, estimated_savings=before-after,
                    measurement="Selected visible text only; excludes provider framing and earlier summary edits.")

    async def apply(self, session_id, body):
        self.replacements.pins.require_version(session_id, body["pin_version"])
        record = await self.replacements.snapshot(session_id, force=True)
        location = record.context["session"]["location"]["directory"]
        # The plugin owns retry receipts and preview freshness, including lost acknowledgments.
        request = {key: body[key] for key in ("run_id", "instance_id", "preview_id", "operation_id")}
        result = await self.replacements.rpc(location, "pruningApply", dict(request, session_id=session_id))
        self.replacements.event(session_id, "pruning", "Manual pruning policy saved")
        return dict(result, run_id=body["run_id"], session_id=session_id)

    async def restore(self, session_id, body):
        record = await self.replacements.snapshot(session_id, force=True)
        location = record.context["session"]["location"]["directory"]
        result = await self.replacements.rpc(location, "pruningRestore", dict(body, session_id=session_id))
        self.replacements.event(session_id, "restore", "Manual pruning restored")
        return dict(result, run_id=body["run_id"], session_id=session_id)

    async def maintain(self):
        while True:
            await asyncio.sleep(15)
            for session_id in list(self.protections):
                async with self.replacements.locked(session_id):
                    try:
                        location, body = self.protections[session_id]
                        capability = await self.replacements.rpc(location, "capabilities", {})
                        body = dict(body, instance_id=capability["instance_id"])
                        await self.replacements.rpc(location, "pruningProtect", body)
                        self.protections[session_id] = (location, body)
                    except (ReviewError, OpenCodeError):
                        pass
