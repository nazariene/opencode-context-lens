"""Dashboard-owned plugin jobs and registrations, renewed independently of browsers."""
import asyncio
import time
from collections import OrderedDict
from contextlib import asynccontextmanager

from .client import OpenCodeError, PluginRejected
from .context import serialized
from .drafts import Drafts
from .history import ReviewError
from .source import digest, wrapped_summary


class Replacements:
    def __init__(self, run_id, client, pins, snapshot, retained, counter):
        self.run_id, self.client, self.pins = run_id, client, pins
        self.snapshot, self.retained, self.counter = snapshot, retained, counter
        self.drafts = Drafts(run_id, pins)
        self.locks = {}
        self.operations = {}
        self.bundles = {}
        self.events = OrderedDict()
        self.event_sequence = 0
        self.events_lost = 0

    @asynccontextmanager
    async def locked(self, session_id):
        if session_id not in self.locks:
            if len(self.locks) >= 4096:
                raise ReviewError(429, "control_capacity", "Run control-session capacity reached.")
            self.locks[session_id] = asyncio.Lock()
        async with self.locks[session_id]:
            yield

    def scope(self, session_id, instance_id):
        return {"session_id": session_id, "run_id": self.run_id, "instance_id": instance_id}

    async def rpc(self, location, method, body):
        if len(serialized({"input": body}).encode()) > 65536:
            raise ReviewError(413, "size_limit", "Serialized control request exceeds 64 KiB. Select fewer invocations.")
        try:
            return await self.client.rpc(location, method, body)
        except PluginRejected as error:
            status = 409 if error.code in {"instance_changed", "owner_conflict", "operation_conflict", "source_changed",
                                         "location_changed", "overlap"} else 429 if error.code == "capacity" else 422
            raise ReviewError(status, error.code, str(error)) from error

    async def capabilities(self, record):
        location = record.context["session"].get("location", {}).get("directory")
        if not location or not hasattr(self.client, "rpc"):
            raise ReviewError(503, "plugin_unavailable", "Context Lens companion plugin is unavailable in this session location.")
        try:
            result = await self.rpc(location, "capabilities", {})
        except OpenCodeError as error:
            raise ReviewError(503, "plugin_unavailable", "Context Lens companion plugin is unavailable in this session location.") from error
        if result.get("protocol") != 1 or not isinstance(result.get("instance_id"), str):
            raise ReviewError(503, "plugin_protocol", "Companion plugin protocol is incompatible.")
        return result

    def event(self, session_id, kind, label):
        self.event_sequence += 1
        self.events[self.event_sequence] = {"id": self.event_sequence, "session_id": session_id,
                                            "at": int(time.time() * 1000), "kind": kind, "label": label}
        session_events = [key for key, event in self.events.items() if event["session_id"] == session_id]
        while len(session_events) > 256:
            del self.events[session_events.pop(0)]
            self.events_lost += 1
        while len(self.events) > 2048:
            self.events.popitem(last=False)
            self.events_lost += 1

    def history(self, session_id):
        return {"control_events": [event for event in self.events.values() if event["session_id"] == session_id],
                "control_events_lost": self.events_lost}

    def operation(self, session_id, operation_id, body):
        now = time.monotonic()
        for key, operation in list(self.operations.items()):
            if operation["state"] != "pending" and now - operation["created"] >= 1800:
                del self.operations[key]
        key = (session_id, operation_id)
        previous = self.operations.get(key)
        if previous and previous["fingerprint"] != digest(body):
            raise ReviewError(409, "operation_conflict", "Operation ID reused with different content.")
        if not previous and len(self.operations) >= 512:
            raise ReviewError(429, "operation_capacity", "Control-operation capacity reached for this run.")
        return key, previous

    async def create_draft(self, session_id, body):
        async with self.locked(session_id):
            existing = self.drafts.existing(session_id, body["operation_id"], body)
            if existing:
                return existing
            record = self.retained(session_id, body["revision"])
            capabilities = await self.capabilities(record) if body["mode"] == "generated" else None
            # No await between validating the current pins and storing their version.
            record = self.retained(session_id, body["revision"])
            if capabilities:
                running = [draft for draft in self.drafts.drafts.values() if draft.state == "generating"
                           or (draft.state == "pending" and draft.pending_action == "generation")]
                if len(running) >= 4 or any(draft.session_id == session_id for draft in running):
                    raise ReviewError(429, "job_capacity", "One generation per session and four per dashboard run are allowed.")
            draft = self.drafts.create(session_id, record, body)
            if capabilities:
                draft.instance_id = capabilities["instance_id"]
                draft.state = "generating"
                request = dict(self.scope(session_id, draft.instance_id), operation_id=body["operation_id"],
                               source_guard=draft.source_guard, units=draft.descriptors(), model=draft.model)
                try:
                    result = await self.rpc(draft.location, "generate", request)
                    self.accept_job(draft, result)
                except OpenCodeError:
                    draft.state, draft.reason = "pending", "Generation admission outcome is pending reconciliation."
                    draft.pending_action = "generation"
                except ReviewError as error:
                    draft.state, draft.reason = "failed", str(error)
            return draft

    def accept_job(self, draft, result):
        draft.job_id = result["job_id"]
        draft.estimated_input = result["estimated_input"]
        if result["state"] == "completed" and draft.state in ("generating", "pending"):
            self.drafts.edit_after_generation(draft, result["summaries"])
        elif result["state"] == "running":
            draft.state, draft.reason = "generating", None
        elif result["state"] != "completed":
            draft.state, draft.reason = result["state"], result.get("reason")

    async def poll_draft(self, draft):
        if (draft.state != "generating" and not (draft.state == "pending" and draft.pending_action == "generation")) or not draft.instance_id:
            return
        try:
            if draft.job_id:
                result = await self.rpc(draft.location, "generationStatus",
                                        dict(self.scope(draft.session_id, draft.instance_id), job_id=draft.job_id))
                self.accept_job(draft, result)
            elif draft.state == "pending":
                # A lost start acknowledgment is resolved with the same operation identity.
                operation_id = next(key[1] for key, (_, draft_id) in self.drafts.operations.items() if draft_id == draft.id)
                result = await self.rpc(draft.location, "status",
                                        dict(self.scope(draft.session_id, draft.instance_id), operation_id=operation_id))
                if result["jobs"]:
                    self.accept_job(draft, result["jobs"][0])
                elif time.monotonic() - draft.created > 45:
                    draft.state, draft.reason = "failed", "Generation was not admitted by the plugin."
        except ReviewError as error:
            draft.state, draft.reason = "failed", str(error)
        except OpenCodeError:
            draft.reason = "Plugin unavailable; job status is unknown until reconciliation or lease expiry."

    async def discard(self, draft):
        if draft.state in ("active", "pending"):
            raise ReviewError(409, "draft_busy", "Reconcile or deactivate this draft before discarding it.")
        if draft.job_id and draft.state == "generating":
            await self.rpc(draft.location, "cancelGeneration", dict(self.scope(draft.session_id, draft.instance_id), job_id=draft.job_id))
        del self.drafts.drafts[draft.id]

    async def activate(self, session_id, draft_id, body):
        async with self.locked(session_id):
            key, previous = self.operation(session_id, body["operation_id"], dict(body, action="activate", draft_id=draft_id))
            if previous:
                await self.reconcile(previous)
                return previous
            draft = self.drafts.get(session_id, body["run_id"], draft_id, body["draft_version"])
            if draft.state != "draft" or not draft.preview or draft.preview["draft_version"] != draft.version:
                raise ReviewError(409, "preview_required", "Preview this exact draft version before activation.")
            self.pins.require_version(session_id, body["pin_version"])
            record = await self.snapshot(session_id, force=True)
            self.drafts.validate_current(draft, record)
            capabilities = await self.capabilities(record)
            if not capabilities.get("profiles"):
                raise ReviewError(422, "unsupported_profile", "No qualified runtime profile is available on this host.")
            instance_id = capabilities["instance_id"]
            if draft.instance_id and draft.instance_id != instance_id:
                raise ReviewError(409, "instance_changed", "Plugin restarted. Create and review a new draft.")
            existing = [bundle for bundle in self.bundles.values() if bundle["state"] in ("registered", "observed-applied", "pending")]
            selected = {unit["call_id"] for unit in draft.units}
            pending = [operation for operation in self.operations.values() if operation["state"] == "pending" and operation["action"] == "activate"]
            if any(operation["session_id"] == session_id and selected & {unit["call_id"] for unit in operation["request"]["units"]} for operation in pending):
                raise ReviewError(409, "overlap", "Selected invocations have a pending activation; reconcile it first.")
            if any(bundle["session_id"] == session_id and selected & set(bundle["call_ids"]) for bundle in existing):
                raise ReviewError(409, "overlap", "Selected invocations already have an active replacement.")
            size = len(serialized(draft.payload()).encode())
            if len(existing) + len(pending) >= 64 or size + sum(bundle["bytes"] for bundle in existing + pending) > 16 * 1024 * 1024:
                raise ReviewError(429, "bundle_capacity", "Active replacement capacity reached.")
            request = dict(self.scope(session_id, instance_id), operation_id=body["operation_id"],
                           source_guard=draft.source_guard, units=draft.descriptors(),
                           summaries=draft.summaries, draft_version=draft.version)
            operation = {"operation_id": body["operation_id"], "session_id": session_id, "run_id": self.run_id,
                         "fingerprint": digest(dict(body, action="activate", draft_id=draft_id)), "created": time.monotonic(),
                         "state": "pending", "action": "activate", "draft_id": draft_id,
                         "location": draft.location, "instance_id": instance_id, "request": request,
                         "result": None, "bytes": size}
            self.operations[key] = operation
            draft.state, draft.instance_id = "pending", instance_id
            draft.pending_action = "activation"
            try:
                result = await self.rpc(draft.location, "activate", request)
                self.accept_activation(operation, result)
            except OpenCodeError:
                await self.reconcile(operation)
            except ReviewError as error:
                draft.state, draft.reason = "draft", str(error)
                operation.update(state="rejected", result={"reason": str(error), "code": error.detail["code"]})
                raise
            return operation

    def accept_activation(self, operation, result):
        draft = self.drafts.drafts[operation["draft_id"]]
        operation.update(state="confirmed", result=result)
        draft.state = "active" if result["state"] in ("registered", "observed-applied") else result["state"]
        self.bundles[result["bundle_id"]] = dict(result, location=operation["location"], instance_id=operation["instance_id"],
                                                 draft_id=draft.id, call_ids=[unit["call_id"] for unit in draft.units],
                                                 bytes=operation["bytes"], last_seen=time.monotonic())
        self.event(draft.session_id, result["state"], f"Summary bundle {result['state']} [{result['bundle_id']}]")

    async def reconcile(self, operation):
        if operation["state"] != "pending":
            return
        try:
            status = await self.rpc(operation["location"], "status",
                                    dict(self.scope(operation["session_id"], operation["instance_id"]),
                                         operation_id=operation["operation_id"]))
            if status["bundles"]:
                if operation["action"] == "activate":
                    self.accept_activation(operation, status["bundles"][0])
                else:
                    self.accept_deactivation(operation, status["bundles"][0])
            elif time.monotonic() - operation["created"] > 45:
                operation.update(state="not_registered", result={"reason": "Operation absent after its lease window."})
                if operation.get("draft_id") in self.drafts.drafts:
                    self.drafts.drafts[operation["draft_id"]].state = "expired"
        except ReviewError as error:
            if error.detail["code"] == "instance_changed":
                operation.update(state="expired", result={"reason": "Plugin instance ended."})
                if operation.get("draft_id") in self.drafts.drafts:
                    self.drafts.drafts[operation["draft_id"]].state = "expired"
        except OpenCodeError:
            pass

    async def deactivate(self, session_id, bundle_id, operation_id):
        body = {"action": "deactivate", "bundle_id": bundle_id, "operation_id": operation_id, "run_id": self.run_id}
        key, previous = self.operation(session_id, operation_id, body)
        if previous:
            await self.reconcile(previous)
            return previous
        bundle = self.bundles.get(bundle_id)
        if not bundle or bundle["session_id"] != session_id:
            raise ReviewError(404, "bundle_missing", "Replacement is not registered for this session.")
        operation = {"operation_id": operation_id, "session_id": session_id, "run_id": self.run_id,
                     "fingerprint": digest(body), "created": time.monotonic(), "state": "pending", "action": "deactivate",
                     "bundle_id": bundle_id, "location": bundle["location"], "instance_id": bundle["instance_id"], "result": None}
        self.operations[key] = operation
        # Stop renewing a bundle as soon as explicit deactivation begins.
        bundle["deactivating"] = True
        try:
            result = await self.rpc(bundle["location"], "deactivate",
                                    dict(self.scope(session_id, bundle["instance_id"]), operation_id=operation_id, bundle_id=bundle_id))
            self.accept_deactivation(operation, result)
        except OpenCodeError:
            await self.reconcile(operation)
        return operation

    def accept_deactivation(self, operation, result):
        operation.update(state="confirmed", result=result)
        bundle = self.bundles[operation["bundle_id"]]
        bundle.update(result, last_seen=time.monotonic())
        draft = self.drafts.drafts.get(bundle["draft_id"])
        if draft:
            draft.state, draft.preview = "deactivated", None
        self.event(operation["session_id"], result["state"], f"Summary bundle {result['state']} [{result['bundle_id']}]")

    async def protect(self, session_id, record, part_ids, version):
        self.pins.additions(session_id, record, part_ids, version)
        anchors = self.pins.anchors(record)
        unit_ids = {anchors[part_id]["unit_id"] for part_id in part_ids}
        calls = {unit["call_id"] for unit in record.provenance["units"] if unit["id"] in unit_ids}
        for operation in list(self.operations.values()):
            if (operation["state"] == "pending" and operation["action"] == "activate" and operation["session_id"] == session_id
                    and calls & {unit["call_id"] for unit in operation["request"]["units"]}):
                await self.reconcile(operation)
                if operation["state"] == "pending":
                    raise ReviewError(409, "protection_pending", "Activation outcome is pending. Protection cannot be committed yet.")
        for bundle in list(self.bundles.values()):
            if bundle["session_id"] == session_id and calls & set(bundle["call_ids"]) and bundle["state"] in ("registered", "observed-applied"):
                operation = await self.deactivate(session_id, bundle["bundle_id"], f"pin-{version}-{bundle['bundle_id']}")
                if operation["state"] == "pending":
                    raise ReviewError(409, "protection_pending", "Deactivation is pending. Protection is not yet committed; retry after acknowledgment or expiry.",
                                      operation_id=operation["operation_id"])
        return self.pins.add(session_id, record, part_ids, version)

    async def status(self, session_id, record):
        result = {"run_id": self.run_id, "session_id": session_id, "available": False, "reason": None,
                  "instance_id": None, "profiles": [], "bundles": [], "projection": None}
        try:
            capability = await self.capabilities(record)
            result.update(available=True, instance_id=capability["instance_id"], profiles=capability["profiles"])
            status = await self.rpc(record.context["session"]["location"]["directory"], "status",
                                    self.scope(session_id, capability["instance_id"]))
            result["bundles"] = [dict(bundle, draft_id=self.bundles.get(bundle["bundle_id"], {}).get("draft_id"))
                                 for bundle in status["bundles"]]
            for incoming in status["bundles"]:
                bundle = self.bundles.get(incoming["bundle_id"])
                if bundle:
                    if bundle["state"] != incoming["state"]:
                        self.event(session_id, incoming["state"], f"Summary bundle {incoming['state']} [{incoming['bundle_id']}]")
                    bundle.update(incoming, last_seen=time.monotonic())
                    draft = self.drafts.drafts.get(bundle["draft_id"])
                    if draft and incoming["state"] not in ("registered", "observed-applied"):
                        draft.state, draft.preview = incoming["state"], None
            for bundle in self.bundles.values():
                if bundle["session_id"] == session_id and bundle["instance_id"] != capability["instance_id"]:
                    bundle["state"] = "expired"
                    draft = self.drafts.drafts.get(bundle["draft_id"])
                    if draft:
                        draft.state, draft.preview = "expired", None
        except (ReviewError, OpenCodeError) as error:
            result.update(available=False, reason=str(error))
        if result["available"]:
            selected, replacement = set(), 0
            for bundle in result["bundles"]:
                local = self.bundles.get(bundle["bundle_id"])
                if bundle["state"] not in ("registered", "observed-applied"):
                    continue
                if not local:
                    result["reason"] = "An unowned or unreconciled bundle is registered. Cumulative projection is unavailable."
                    return result
                draft = self.drafts.drafts.get(local["draft_id"])
                if not draft:
                    continue
                for unit in draft.units:
                    current = next((source for source in record.source_units.values() if source["call_id"] == unit["call_id"]
                                    and source["fingerprint"] == unit["fingerprint"]), None)
                    if not current:
                        result["reason"] = "Registered source changed; the next hook will suspend its bundle. Projection unavailable."
                        return result
                    selected.add(current["unit_id"])
                replacement += sum(self.counter().count(wrapped_summary(unit, draft.summaries[unit["unit_id"]]))
                                   for unit in draft.units)
            ids = {part_id for unit in record.analysis["units"] if unit["id"] in selected for part_id in unit["part_ids"]} if record.analysis else set()
            source = sum(part["tokens"] or 0 for part in record.context["parts"] if part["id"] in ids)
            result["projection"] = {"original_visible_tokens": record.context["tokens"],
                                    "projected_visible_tokens": record.context["tokens"] - source + replacement,
                                    "estimated_savings": source - replacement, "provider_savings_verified": False}
        return result

    def public_operation(self, operation):
        return {key: operation[key] for key in ("run_id", "session_id", "operation_id", "state", "result")}

    async def maintain(self):
        while True:
            await asyncio.sleep(15)
            await self.tick()

    async def tick(self):
        self.drafts.expire()
        groups = {}
        for bundle in self.bundles.values():
            if bundle["state"] in ("registered", "observed-applied") and not bundle.get("deactivating"):
                key = (bundle["session_id"], bundle["location"], bundle["instance_id"])
                groups.setdefault(key, {"bundle_ids": [], "job_ids": []})["bundle_ids"].append(bundle["bundle_id"])
        for draft in self.drafts.drafts.values():
            if draft.state == "generating" and draft.job_id:
                key = (draft.session_id, draft.location, draft.instance_id)
                groups.setdefault(key, {"bundle_ids": [], "job_ids": []})["job_ids"].append(draft.job_id)
        async def renew(key, ids):
            session_id, location, instance_id = key
            async with self.locked(session_id):
                try:
                    current = (await self.client.get(f"/api/session/{session_id}"))["data"]
                    if current.get("location", {}).get("directory") != location:
                        for bundle_id in ids["bundle_ids"]:
                            await self.deactivate(session_id, bundle_id, "move-" + bundle_id)
                        for job_id in ids["job_ids"]:
                            await self.rpc(location, "cancelGeneration", dict(self.scope(session_id, instance_id), job_id=job_id))
                        return
                    result = await self.rpc(location, "renew", dict(self.scope(session_id, instance_id), **ids))
                    for incoming in result["bundles"]:
                        bundle = self.bundles.get(incoming["bundle_id"])
                        if bundle:
                            if bundle["state"] != incoming["state"]:
                                self.event(session_id, incoming["state"], f"Summary bundle {incoming['state']} [{incoming['bundle_id']}]")
                            bundle.update(incoming, last_seen=time.monotonic())
                            draft = self.drafts.drafts.get(bundle["draft_id"])
                            if draft and incoming["state"] not in ("registered", "observed-applied"):
                                draft.state, draft.preview = incoming["state"], None
                except (OpenCodeError, ReviewError):
                    pass
        await asyncio.gather(*(renew(key, ids) for key, ids in groups.items()))
        for operation in list(self.operations.values()):
            async with self.locked(operation["session_id"]):
                await self.reconcile(operation)
        for draft in list(self.drafts.drafts.values()):
            if draft.state in ("generating", "pending") and draft.instance_id:
                async with self.locked(draft.session_id):
                    await self.poll_draft(draft)
        for bundle_id, bundle in list(self.bundles.items()):
            if bundle["state"] not in ("registered", "observed-applied") and time.monotonic() - bundle["last_seen"] >= 1800:
                del self.bundles[bundle_id]

    async def close(self):
        async def stop_bundle(bundle):
            try:
                await self.deactivate(bundle["session_id"], bundle["bundle_id"], "shutdown-" + bundle["bundle_id"])
            except (OpenCodeError, ReviewError):
                pass
        async def stop_job(draft):
            try:
                await self.rpc(draft.location, "cancelGeneration", dict(self.scope(draft.session_id, draft.instance_id), job_id=draft.job_id))
            except (OpenCodeError, ReviewError):
                pass
        await asyncio.gather(*(stop_bundle(bundle) for bundle in self.bundles.values() if bundle["state"] in ("registered", "observed-applied")),
                             *(stop_job(draft) for draft in self.drafts.drafts.values() if draft.state == "generating" and draft.job_id))
