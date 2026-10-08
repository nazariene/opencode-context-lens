import asyncio
import logging
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, StringConstraints

from .analysis import InvalidSelection, build_analysis, preview_selection
from .client import OpenCodeClient, OpenCodeError
from .context import TokenCounter, build_context
from .settings import Settings

STATIC = Path(__file__).parent / "static"
logger = logging.getLogger(__name__)


class PreviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    revision: Annotated[str, StringConstraints(min_length=1, max_length=128)]
    unit_ids: list[Annotated[str, StringConstraints(min_length=1)]]


@dataclass(frozen=True)
class Snapshot:
    context: dict
    analysis: dict | None


def build_snapshot(session, messages, model, counter, previous=None):
    provenance = {}
    context = build_context(session, messages, model, counter, provenance)
    if previous and previous.context["revision"] == context["revision"] and previous.analysis is not None:
        return Snapshot(context, previous.analysis)
    try:
        analysis = build_analysis(context, provenance)
    except Exception:
        logger.exception("Context analysis unavailable")
        analysis = None
    return Snapshot(context, analysis)


def validate_session_id(session_id):
    if not session_id.startswith("ses") or not session_id.replace("_", "").isalnum():
        raise HTTPException(400, "Invalid session ID")


def create_app(settings: Settings, client=None, counter=None):
    client = client or OpenCodeClient(settings)
    snapshots = OrderedDict()
    model_cache = OrderedDict()
    snapshot_lock = asyncio.Lock()

    @asynccontextmanager
    async def lifespan(app):
        app.state.counter = counter or await asyncio.to_thread(TokenCounter)
        yield

    app = FastAPI(title="OpenCode Context", lifespan=lifespan, docs_url=None, redoc_url=None)

    @app.middleware("http")
    async def response_headers(request, call_next):
        response = await call_next(request)
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

    @app.get("/api/settings")
    async def public_settings():
        return {"executable": client.executable, "refresh_seconds": settings.refresh_seconds,
                "server": settings.opencode_server or "Managed local service"}

    @app.get("/api/sessions")
    async def sessions(search: str = "", cursor: str | None = None):
        response, active = await asyncio.gather(
            client.get("/api/session", limit=50, search=search or None, cursor=cursor),
            client.get("/api/session/active"),
        )
        return {"sessions": [dict(session, active=session["id"] in active["data"]) for session in response["data"]],
                "next": response.get("cursor", {}).get("next")}

    async def snapshot(session_id):
        async with snapshot_lock:
            cached = snapshots.get(session_id)
            if cached and time.monotonic() - cached[0] < settings.refresh_seconds:
                snapshots.move_to_end(session_id)
                return cached[1]
            session_response, context_response = await asyncio.gather(
                client.get(f"/api/session/{session_id}"), client.get(f"/api/session/{session_id}/context")
            )
            session = session_response["data"]
            directory = session.get("location", {}).get("directory", "")
            models = model_cache.get(directory)
            warning = None
            if not models or time.monotonic() - models[0] > 300:
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
                                             app.state.counter, cached[1] if cached else None)
            context = record.context
            context["warning"] = warning
            context["fetched_at"] = int(time.time() * 1000)
            snapshots[session_id] = (time.monotonic(), record)
            snapshots.move_to_end(session_id)
            if len(snapshots) > 8:
                snapshots.popitem(last=False)
            return record

    @app.get("/api/sessions/{session_id}/context")
    async def context(session_id: str):
        validate_session_id(session_id)
        context = (await snapshot(session_id)).context
        return dict(context, parts=[{key: value for key, value in part.items() if key != "text"}
                                    for part in context["parts"]])

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
        return retained_analysis(session_id, revision).analysis

    @app.post("/api/sessions/{session_id}/cleanup-preview")
    async def cleanup_preview(session_id: str, selection: PreviewRequest):
        record = retained_analysis(session_id, selection.revision)
        try:
            return await asyncio.to_thread(preview_selection, record.context, record.analysis, selection.unit_ids)
        except InvalidSelection as error:
            raise HTTPException(422, error.detail) from error
        except Exception as error:
            logger.exception("Context preview unavailable")
            raise HTTPException(500, {"code": "analysis_unavailable",
                                     "message": "The preview could not be calculated. Refresh and retry."}) from error

    @app.get("/")
    async def index():
        return FileResponse(STATIC / "index.html")

    app.mount("/static", StaticFiles(directory=STATIC), name="static")
    return app
