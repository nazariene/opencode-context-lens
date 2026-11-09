import asyncio
import logging
import time
import uuid
from collections import OrderedDict
from contextlib import asynccontextmanager, suppress
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit
from weakref import WeakValueDictionary

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

from .analysis import InvalidSelection, build_analysis, preview_selection
from .client import OpenCodeClient, OpenCodeError
from .context import TokenCounter, build_context, serialized
from .controls import Pins
from .diff import compare_snapshots
from .history import History, ReviewError, text_free
from .pruning import PruningControls
from .replacements import Replacements
from .settings import Settings
from .source import digest, source_record, source_units

STATIC = Path(__file__).parent / "static"
logger = logging.getLogger(__name__)


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    revision: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    unit_ids: list[Annotated[str, StringConstraints(min_length=1)]]


class PinVersion(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    run_id: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    pin_version: Annotated[int, Field(ge=0)]


class PinRequest(PinVersion):
    revision: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    part_ids: list[Annotated[str, StringConstraints(min_length=1, max_length=512)]]


Identifier = Annotated[str, StringConstraints(min_length=1, max_length=128)]


class ModelRef(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    providerID: Identifier
    id: Identifier
    variant: Identifier | None = None


class CreateDraft(PinVersion):
    revision: Identifier
    operation_id: Identifier
    unit_ids: Annotated[list[Identifier], Field(min_length=1, max_length=128)]
    mode: Literal["manual", "generated"]
    summaries: dict[str, str] | None = None
    model: ModelRef | None = None

    @model_validator(mode="after")
    def mode_fields(self):
        if self.mode == "manual" and (self.summaries is None or "model" in self.model_fields_set):
            raise ValueError("Manual drafts require summaries and reject model.")
        if self.mode == "generated" and "summaries" in self.model_fields_set:
            raise ValueError("Generated drafts reject summaries.")
        return self


class DraftVersion(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    run_id: Identifier
    draft_version: Annotated[int, Field(ge=1)]


class EditDraft(DraftVersion):
    summaries: dict[str, str]


class ActivateDraft(DraftVersion):
    pin_version: Annotated[int, Field(ge=0)]
    operation_id: Identifier


class DeactivateBundle(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    run_id: Identifier
    operation_id: Identifier


class PruningPreview(PinVersion):
    snapshot_revision: Identifier
    instance_id: Identifier
    source_guard: Identifier
    revision: Annotated[int, Field(ge=0)]
    target_ids: Annotated[list[Annotated[str, StringConstraints(min_length=1, max_length=512)]], Field(min_length=1, max_length=512)]
    action: Literal["prune-result", "remove-reasoning", "delete-invocation", "delete-range", "summarize-brief", "summarize-full"]


class PruningApply(PinVersion):
    instance_id: Identifier
    preview_id: Identifier
    operation_id: Identifier


class PruningRestore(DeactivateBundle):
    instance_id: Identifier
    revision: Annotated[int, Field(ge=0)]
    group_ids: Annotated[list[Identifier], Field(min_length=1, max_length=512)]


@dataclass(frozen=True)
class Snapshot:
    context: dict
    analysis: dict | None
    provenance: dict
    payload_bytes: int
    source_guard: str | None
    source_units: dict
    source_error: str | None
    control_id: str


def build_snapshot(session, messages, model, counter, previous=None, warning=None):
    provenance = {}
    context = build_context(session, messages, model, counter, provenance)
    if previous and previous.context["revision"] == context["revision"] and previous.analysis is not None:
        analysis = previous.analysis
    else:
        try:
            analysis = build_analysis(context, provenance)
        except Exception:
            logger.exception("Context analysis unavailable")
            analysis = None
    context.update(warning=warning, fetched_at=int(time.time() * 1000))
    try:
        guard, units, source_error = digest(source_record(session, messages)), source_units(session, messages), None
    except ReviewError as error:
        guard, units, source_error = None, {}, str(error)
    control_id = uuid.uuid4().hex
    size = len(serialized({"context": context, "analysis": analysis, "provenance": provenance,
                           "source_guard": guard, "source_units": units, "source_error": source_error,
                           "control_id": control_id}).encode())
    return Snapshot(context, analysis, provenance, size, guard, units, source_error, control_id)


def validate_session_id(session_id):
    if not session_id.startswith("ses") or not session_id.replace("_", "").isalnum():
        raise HTTPException(400, "Invalid session ID")


def create_app(settings: Settings, client=None, counter=None):
    client = client or OpenCodeClient(settings)
    snapshots = OrderedDict()
    model_cache = OrderedDict()
    snapshot_locks = WeakValueDictionary()
    history = History(settings)
    pins = Pins(history.run_id)

    @asynccontextmanager
    async def lifespan(app):
        app.state.counter = counter or await asyncio.to_thread(TokenCounter)
        renewal = asyncio.create_task(replacements.maintain())
        protection = asyncio.create_task(pruning.maintain())
        try:
            yield
        finally:
            renewal.cancel()
            protection.cancel()
            with suppress(asyncio.CancelledError):
                await protection
            with suppress(asyncio.CancelledError):
                await renewal
            with suppress(TimeoutError):
                await asyncio.wait_for(replacements.close(), timeout=5)

    app = FastAPI(title="OpenCode Context", lifespan=lifespan, docs_url=None, redoc_url=None)
    app.state.history = history
    app.state.pins = pins

    @app.middleware("http")
    async def response_headers(request, call_next):
        action = request.method in {"POST", "PATCH", "DELETE"} and any(
            segment in request.url.path for segment in ("/pins", "/summary-drafts", "/replacements", "/pruning"))
        error = None
        if action:
            host = request.headers.get("host", "")
            allowed_host = f"[{settings.host}]:{settings.port}" if ":" in settings.host else f"{settings.host}:{settings.port}"
            origin = request.headers.get("origin")
            try:
                parsed = urlsplit(origin) if origin else None
            except ValueError:
                parsed = urlsplit("invalid:")
            if host != allowed_host or (parsed and (parsed.scheme != "http" or parsed.netloc != allowed_host or parsed.path not in ("", "/") or parsed.query or parsed.fragment)):
                error = (403, "origin_rejected", "Action Origin/Host must match the configured dashboard address.")
            elif request.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "application/json":
                error = (415, "json_required", "State actions require application/json.")
            elif len(await request.body()) > 65536:
                error = (413, "size_limit", "Control request exceeds 64 KiB.")
        response = JSONResponse({"detail": {"code": error[1], "message": error[2]}}, status_code=error[0]) if error else await call_next(request)
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
            "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"
        )
        return response

    @app.exception_handler(OpenCodeError)
    async def opencode_error(request, error):
        return JSONResponse({"detail": str(error)}, status_code=502)

    @app.exception_handler(ReviewError)
    async def review_error(request, error):
        return JSONResponse({"detail": error.detail}, status_code=error.status)

    @app.get("/api/settings")
    async def public_settings():
        return {"executable": client.executable, "refresh_seconds": settings.refresh_seconds,
                "run_id": history.run_id,
                "server": settings.opencode_server or "Managed local service"}

    @app.get("/api/sessions")
    async def sessions(search: str = "", cursor: str | None = None):
        response, active = await asyncio.gather(
            client.get("/api/session", limit=50, search=search or None, cursor=cursor),
            client.get("/api/session/active"),
        )
        return {"sessions": [dict(session, active=session["id"] in active["data"]) for session in response["data"]],
                "next": response.get("cursor", {}).get("next")}

    async def snapshot(session_id, force=False):
        started = time.monotonic()
        lock = snapshot_locks.setdefault(session_id, asyncio.Lock())
        async with lock:
            cached = snapshots.get(session_id)
            if cached and not force and (time.monotonic() - cached[0] < settings.refresh_seconds
                                         or cached[0] >= started):
                snapshots.move_to_end(session_id)
                return cached[1]
            session_response, context_response = await asyncio.gather(
                client.get(f"/api/session/{session_id}"), client.get(f"/api/session/{session_id}/context")
            )
            session = session_response["data"]
            directory = session.get("location", {}).get("directory", "")
            models = model_cache.get(directory)
            warning = None
            if force or not models or time.monotonic() - models[0] > 300:
                try:
                    response = await client.get("/api/model", **{"location[directory]": directory})
                    models = (time.monotonic(), response["data"])
                    model_cache[directory] = models
                    model_cache.move_to_end(directory)
                    if len(model_cache) > 16:
                        model_cache.popitem(last=False)
                except OpenCodeError:
                    models = None
                    warning = "Model information is unavailable; context-window percentages are unknown."
            reference = session.get("model") or {}
            model = next((model for model in (models[1] if models else [])
                          if model["id"] == reference.get("id")
                          and model["providerID"] == reference.get("providerID")), None)
            if not model and not warning:
                warning = "No matching model limit is available; context-window percentages are unknown."
            record = await asyncio.to_thread(build_snapshot, session, context_response["data"], model,
                                             app.state.counter, cached[1] if cached else None, warning)
            snapshots[session_id] = (time.monotonic(), record)
            snapshots.move_to_end(session_id)
            if len(snapshots) > 8:
                snapshots.popitem(last=False)
            history.observe(record)
            return record

    @app.get("/api/sessions/{session_id}/context")
    async def context(session_id: str):
        validate_session_id(session_id)
        context = (await snapshot(session_id)).context
        return dict(text_free(context), run_id=history.run_id)

    @app.get("/api/sessions/{session_id}/history")
    async def session_history(session_id: str):
        validate_session_id(session_id)
        return dict(history.summary(session_id), **replacements.history(session_id))

    @app.get("/api/sessions/{session_id}/history/{snapshot_id}")
    async def historical_context(session_id: str, snapshot_id: Identifier, run_id: str = Query(min_length=1, max_length=128)):
        validate_session_id(session_id)
        observation, record = history.get(session_id, run_id, snapshot_id)
        return dict(text_free(record.context), run_id=history.run_id, session_id=session_id, snapshot_id=snapshot_id,
                    observation=observation.metadata(), historical_analysis=record.analysis)

    @app.get("/api/sessions/{session_id}/history/{snapshot_id}/part")
    async def historical_part(session_id: str, snapshot_id: Identifier, run_id: str = Query(min_length=1, max_length=128),
                              id: str = Query(min_length=1, max_length=512)):
        validate_session_id(session_id)
        _, record = history.get(session_id, run_id, snapshot_id)
        selected = next((part for part in record.context["parts"] if part["id"] == id), None)
        if not selected:
            raise ReviewError(404, "part_missing", "Part is not in this historical snapshot.")
        return dict(selected, run_id=run_id, session_id=session_id, snapshot_id=snapshot_id)

    @app.get("/api/sessions/{session_id}/diff")
    async def context_diff(session_id: str, run_id: str = Query(min_length=1, max_length=128),
                           before: str = Query(min_length=1, max_length=128), after: str = Query(min_length=1, max_length=128)):
        validate_session_id(session_id)
        left_observation, left = history.get(session_id, run_id, before)
        right_observation, right = history.get(session_id, run_id, after)
        comparison = await asyncio.to_thread(compare_snapshots, left, right)
        comparison["before"]["reported"] = left_observation.reported
        comparison["after"]["reported"] = right_observation.reported
        comparison["before"]["observation"] = left_observation.metadata()
        comparison["after"]["observation"] = right_observation.metadata()
        return dict(comparison, run_id=run_id, session_id=session_id, before_id=before, after_id=after)

    @app.get("/api/sessions/{session_id}/part")
    async def part(session_id: str, id: str = Query(), revision: str = Query()):
        cached = snapshots.get(session_id)
        if not cached or cached[1].context["revision"] != revision:
            raise HTTPException(409, "Context changed. Refresh to inspect the latest version.")
        selected = next((part for part in cached[1].context["parts"] if part["id"] == id), None)
        if not selected:
            raise HTTPException(404, "Context part not found")
        return selected

    def retained_analysis(session_id, revision):
        validate_session_id(session_id)
        cached = snapshots.get(session_id)
        if not cached or cached[1].context["revision"] != revision:
            raise HTTPException(409, {"code": "snapshot_changed",
                                     "message": "This snapshot is no longer available. Refresh context and reselect."})
        if cached[1].analysis is None:
            raise HTTPException(500, {"code": "analysis_unavailable",
                                     "message": "Analysis is unavailable for this snapshot. Refresh to retry."})
        return cached[1]

    @app.get("/api/sessions/{session_id}/analysis")
    async def analysis(session_id: str, revision: str = Query(min_length=1, max_length=128)):
        record = retained_analysis(session_id, revision)
        return pins.project(session_id, record)

    @app.get("/api/sessions/{session_id}/pins")
    async def session_pins(session_id: str):
        validate_session_id(session_id)
        cached = snapshots.get(session_id)
        return pins.describe(session_id, cached[1] if cached else None)

    @app.post("/api/sessions/{session_id}/pins")
    async def pin_parts(session_id: str, body: PinRequest):
        history.require_run(body.run_id)
        async with replacements.locked(session_id):
            record = retained_analysis(session_id, body.revision)
            _, additions = pins.additions(session_id, record, body.part_ids, body.pin_version)
            protected = {part for pin in pins.describe(session_id, record)["pins"] for part in pin["part_ids"]}
            protected.update(body.part_ids)
            # Pin both halves when any member of an invocation is protected.
            for unit in record.provenance["units"]:
                if protected.intersection(unit["part_ids"]):
                    protected.update(unit["part_ids"])
            await pruning.protect(session_id, record, protected, body.pin_version + bool(additions))
            try:
                result = await replacements.protect(session_id, record, body.part_ids, body.pin_version)
            except Exception:
                original = {part for pin in pins.describe(session_id, record)["pins"] for part in pin["part_ids"]}
                with suppress(ReviewError, OpenCodeError):
                    await pruning.protect(session_id, record, original, pins.version(session_id))
                # Stop renewing a provisional pin publication if rollback could not reach the plugin.
                if pruning.protections.get(session_id, (None, {}))[1].get("pin_version") != pins.version(session_id):
                    pruning.protections.pop(session_id, None)
                raise
            replacements.event(session_id, "pin", "Context protection updated")
            return result

    @app.delete("/api/sessions/{session_id}/pins/{pin_id}")
    async def unpin(session_id: str, pin_id: str, body: PinVersion):
        validate_session_id(session_id)
        history.require_run(body.run_id)
        async with replacements.locked(session_id):
            cached = snapshots.get(session_id)
            if not cached and session_id in pruning.protections:
                await snapshot(session_id)
                cached = snapshots.get(session_id)
            pins.require_version(session_id, body.pin_version)
            if cached:
                described = pins.describe(session_id, cached[1])
                if not any(pin["id"] == pin_id for pin in described["pins"]):
                    raise ReviewError(404, "pin_missing", "Pin is no longer present.")
                protected = {part for pin in described["pins"] if pin["id"] != pin_id for part in pin["part_ids"]}
                await pruning.protect(session_id, cached[1], protected, body.pin_version + 1)
            result = pins.remove(session_id, pin_id, body.pin_version, cached[1] if cached else None)
            replacements.event(session_id, "unpin", "Context protection removed")
            return result

    replacements = Replacements(history.run_id, client, pins, snapshot, retained_analysis, lambda: app.state.counter)
    app.state.replacements = replacements
    pruning = PruningControls(replacements)
    app.state.pruning = pruning

    @app.get("/api/sessions/{session_id}/pruning")
    async def pruning_status(session_id: str, revision: str | None = Query(default=None, min_length=1, max_length=128)):
        validate_session_id(session_id)
        async with replacements.locked(session_id):
            record = retained_analysis(session_id, revision) if revision else await snapshot(session_id)
            return await pruning.inspect(session_id, record)

    @app.post("/api/sessions/{session_id}/pruning/preview")
    async def preview_pruning(session_id: str, body: PruningPreview):
        validate_session_id(session_id)
        history.require_run(body.run_id)
        return await pruning.preview(session_id, body.model_dump())

    @app.post("/api/sessions/{session_id}/pruning/apply")
    async def apply_pruning(session_id: str, body: PruningApply):
        validate_session_id(session_id)
        history.require_run(body.run_id)
        async with replacements.locked(session_id):
            return await pruning.apply(session_id, body.model_dump())

    @app.post("/api/sessions/{session_id}/pruning/restore")
    async def restore_pruning(session_id: str, body: PruningRestore):
        validate_session_id(session_id)
        history.require_run(body.run_id)
        async with replacements.locked(session_id):
            return await pruning.restore(session_id, body.model_dump())

    def cached_record(session_id):
        cached = snapshots.get(session_id)
        return cached[1] if cached else None

    @app.post("/api/sessions/{session_id}/summary-drafts")
    async def create_draft(session_id: str, body: CreateDraft):
        validate_session_id(session_id)
        history.require_run(body.run_id)
        try:
            draft = await replacements.create_draft(session_id, body.model_dump(exclude_none=True))
        except InvalidSelection as error:
            raise HTTPException(422, error.detail) from error
        return JSONResponse(replacements.drafts.describe(draft, cached_record(session_id)),
                            status_code=202 if draft.state in ("generating", "pending") else 201)

    @app.get("/api/sessions/{session_id}/summary-drafts/{draft_id}")
    async def get_draft(session_id: str, draft_id: str, run_id: Annotated[Identifier, Query()]):
        validate_session_id(session_id)
        async with replacements.locked(session_id):
            draft = replacements.drafts.get(session_id, run_id, draft_id)
            await replacements.poll_draft(draft)
            return replacements.drafts.describe(draft, cached_record(session_id))

    @app.patch("/api/sessions/{session_id}/summary-drafts/{draft_id}")
    async def edit_draft(session_id: str, draft_id: str, body: EditDraft):
        validate_session_id(session_id)
        async with replacements.locked(session_id):
            draft = replacements.drafts.get(session_id, body.run_id, draft_id, body.draft_version)
            replacements.drafts.edit(draft, body.summaries)
            return replacements.drafts.describe(draft, cached_record(session_id))

    @app.delete("/api/sessions/{session_id}/summary-drafts/{draft_id}")
    async def discard_draft(session_id: str, draft_id: str, body: DraftVersion):
        validate_session_id(session_id)
        async with replacements.locked(session_id):
            draft = replacements.drafts.get(session_id, body.run_id, draft_id, body.draft_version)
            await replacements.discard(draft)
            return {"run_id": history.run_id, "session_id": session_id, "draft_id": draft_id, "state": "discarded"}

    @app.post("/api/sessions/{session_id}/summary-drafts/{draft_id}/preview")
    async def preview_draft(session_id: str, draft_id: str, body: DraftVersion):
        validate_session_id(session_id)
        async with replacements.locked(session_id):
            draft = replacements.drafts.get(session_id, body.run_id, draft_id, body.draft_version)
            record = retained_analysis(session_id, draft.revision)
            preview = await asyncio.to_thread(replacements.drafts.preview, draft, record, app.state.counter)
            runtime = await replacements.status(session_id, record)
            cumulative = runtime.get("projection")
            preview["cumulative_projected_visible_tokens"] = (
                cumulative["projected_visible_tokens"] - preview["estimated_savings"] if cumulative else None)
            if any(bundle["session_id"] == session_id and bundle["state"] in ("registered", "observed-applied")
                   and set(bundle["call_ids"]) & {unit["call_id"] for unit in draft.units}
                   for bundle in replacements.bundles.values()):
                raise ReviewError(409, "overlap", "A selected invocation already has an active replacement.")
            replacements.drafts.validate_current(draft, retained_analysis(session_id, draft.revision))
            draft.preview = preview
            return preview

    @app.post("/api/sessions/{session_id}/summary-drafts/{draft_id}/activate")
    async def activate_draft(session_id: str, draft_id: str, body: ActivateDraft):
        validate_session_id(session_id)
        history.require_run(body.run_id)
        operation = await replacements.activate(session_id, draft_id, body.model_dump())
        return JSONResponse(replacements.public_operation(operation), status_code=202 if operation["state"] == "pending" else 200)

    @app.get("/api/sessions/{session_id}/replacements")
    async def replacement_status(session_id: str):
        validate_session_id(session_id)
        record = cached_record(session_id)
        if not record:
            return {"run_id": history.run_id, "session_id": session_id, "available": False,
                    "reason": "Live context is no longer cached. Refresh context to inspect plugin status.",
                    "instance_id": None, "profiles": [], "bundles": [], "projection": None,
                    "operations": [], "models": []}
        async with replacements.locked(session_id):
            result = await replacements.status(session_id, record)
            for operation in list(replacements.operations.values()):
                if operation["session_id"] == session_id:
                    await replacements.reconcile(operation)
            result["operations"] = [replacements.public_operation(operation) for operation in replacements.operations.values()
                                    if operation["session_id"] == session_id]
            models = model_cache.get(record.context["session"].get("location", {}).get("directory"))
            result["models"] = [{key: model[key] for key in ("id", "providerID", "name", "limit")} for model in models[1]] if models else []
            return result

    @app.post("/api/sessions/{session_id}/replacements/{bundle_id}/deactivate")
    async def deactivate_bundle(session_id: str, bundle_id: str, body: DeactivateBundle):
        validate_session_id(session_id)
        history.require_run(body.run_id)
        async with replacements.locked(session_id):
            operation = await replacements.deactivate(session_id, bundle_id, body.operation_id)
            return JSONResponse(replacements.public_operation(operation), status_code=202 if operation["state"] == "pending" else 200)

    @app.post("/api/sessions/{session_id}/cleanup-preview")
    async def cleanup_preview(session_id: str, selection: PreviewRequest):
        record = retained_analysis(session_id, selection.revision)
        pins.validate_selection(session_id, record, selection.unit_ids)
        pin_version = pins.version(session_id)
        try:
            preview = await asyncio.to_thread(preview_selection, record.context, record.analysis, selection.unit_ids)
            pins.require_version(session_id, pin_version)
            return dict(preview, run_id=history.run_id, pin_version=pin_version)
        except InvalidSelection as error:
            raise HTTPException(422, error.detail) from error
        except ReviewError:
            raise
        except Exception as error:
            logger.exception("Context preview unavailable")
            raise HTTPException(500, {"code": "analysis_unavailable",
                                     "message": "The preview could not be calculated. Refresh and retry."}) from error

    @app.get("/")
    async def index():
        return FileResponse(STATIC / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app
