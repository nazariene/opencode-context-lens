import asyncio
import json
import subprocess
from copy import deepcopy
from pathlib import Path

import pytest
from analysis_fixtures import Counter, DemoClient, message, tool
from fastapi.testclient import TestClient

from viewer.client import OpenCodeError, PluginRejected
from viewer.server import create_app
from viewer.settings import Settings
from viewer.source import digest, source_record, source_units

BASE = "/api/sessions/ses_example"
ORIGIN = "http://127.0.0.1:9193"


class PluginClient(DemoClient):
    def __init__(self):
        super().__init__([message("user", "msg_user", text="Review"),
                          message("assistant", "msg_calls", content=[{**tool(outputs=[{"type": "text", "text": "Short result"}]), "id": "call_a"}])])
        self.instance = "plugin_fixture"
        self.bundles = {}
        self.rpc_calls = []
        self.lose_activate = False
        self.lose_deactivate = False
        self.reject = False
        self.jobs = {}
        self.status_unavailable = False

    async def rpc(self, location, method, body):
        self.rpc_calls.append((location, method, deepcopy(body)))
        if method == "capabilities":
            return {"protocol": 1, "instance_id": self.instance, "profiles": ["fixture"], "generation": True}
        if body["instance_id"] != self.instance:
            raise PluginRejected("instance_changed", "Plugin restarted")
        if method == "generate":
            result = {"job_id": "job_fixture", "operation_id": body["operation_id"], "session_id": body["session_id"],
                      "run_id": body["run_id"], "state": "running", "expires_at": 45000, "reason": None,
                      "summaries": None, "model": body["model"], "estimated_input": 123, "actual_usage": None}
            self.jobs[result["job_id"]] = result
            return deepcopy(result)
        if method in ("generationStatus", "cancelGeneration"):
            result = self.jobs[body["job_id"]]
            if method == "cancelGeneration":
                result["state"] = "cancelled"
            return deepcopy(result)
        if method == "activate":
            if self.reject:
                raise PluginRejected("source_changed", "Source changed before admission")
            result = {"bundle_id": "bundle_fixture", "operation_id": body["operation_id"],
                      "session_id": body["session_id"], "run_id": body["run_id"], "draft_version": body["draft_version"],
                      "state": "registered", "expires_at": 45000, "reason": None, "evidence": None}
            self.bundles[result["bundle_id"]] = result
            if self.lose_activate:
                raise OpenCodeError("Lost acknowledgment")
            return deepcopy(result)
        if method == "deactivate":
            result = self.bundles[body["bundle_id"]]
            result["state"] = "deactivated"
            result["deactivation_operation"] = body["operation_id"]
            if self.lose_deactivate:
                raise OpenCodeError("Lost acknowledgment")
            return deepcopy(result)
        if method in ("status", "renew"):
            if self.status_unavailable:
                raise OpenCodeError("Plugin status unavailable")
            bundles = list(self.bundles.values())
            if body.get("operation_id"):
                bundles = [b for b in bundles if body["operation_id"] in (b["operation_id"], b.get("deactivation_operation"))]
            return {"protocol": 1, "instance_id": self.instance, "session_id": body["session_id"], "bundles": deepcopy(bundles), "jobs": deepcopy(list(self.jobs.values()))}
        raise AssertionError(method)


def make_draft(client, text="A very long summary " * 30):
    context = client.get(BASE + "/context").json()
    body = {"run_id": context["run_id"], "revision": context["revision"], "pin_version": 0,
            "operation_id": "create", "unit_ids": ["msg_calls:0"], "mode": "manual", "summaries": {"msg_calls:0": text}}
    response = client.post(BASE + "/summary-drafts", json=body)
    assert response.status_code == 201, response.text
    return context, response.json(), body


def test_manual_draft_versions_negative_savings_and_no_plugin_required():
    source = PluginClient()
    app = create_app(Settings(), source, Counter())
    with TestClient(app, base_url=ORIGIN) as client:
        context, draft, body = make_draft(client)
        assert not any(method in ("generate", "activate", "deactivate") for _, method, _ in source.rpc_calls)
        assert client.post(BASE + "/summary-drafts", json=body).json()["draft_id"] == draft["draft_id"]
        assert client.post(BASE + "/summary-drafts", json={**body, "summaries": {"msg_calls:0": "Other"}}).status_code == 409
        path = BASE + "/summary-drafts/" + draft["draft_id"]
        version = {"run_id": context["run_id"], "draft_version": 1}
        preview = client.post(path + "/preview", json=version).json()
        assert preview["estimated_savings"] < 0
        assert preview["projected_visible_tokens"] == preview["before_visible_tokens"] - preview["selected_source_tokens"] + preview["replacement_tokens"]
        assert preview["replacement_tokens"] > Counter().count(body["summaries"]["msg_calls:0"])
        edited = client.patch(path, json={**version, "summaries": {"msg_calls:0": "Edited"}}).json()
        assert edited["draft_version"] == 2 and edited["preview"] is None
        assert client.post(path + "/activate", json={**version, "pin_version": 0, "operation_id": "old"}).status_code == 409
        assert not any(method in ("generate", "activate", "deactivate") for _, method, _ in source.rpc_calls)


def test_activation_fresh_validation_lost_ack_projection_and_pin_deactivation():
    source = PluginClient()
    source.lose_activate = source.lose_deactivate = True
    app = create_app(Settings(), source, Counter())
    with TestClient(app, base_url=ORIGIN) as client:
        context, draft, _ = make_draft(client, "Summary")
        path = BASE + "/summary-drafts/" + draft["draft_id"]
        version = {"run_id": context["run_id"], "draft_version": 1}
        client.post(path + "/preview", json=version).raise_for_status()
        before = len(source.calls)
        body = {**version, "pin_version": 0, "operation_id": "activate"}
        activated = client.post(path + "/activate", json=body)
        assert activated.status_code == 200, activated.text
        assert activated.json()["result"]["state"] == "registered"
        assert len(source.calls) >= before + 3
        assert client.post(path + "/activate", json=body).json() == activated.json()
        assert sum(method == "activate" for _, method, _ in source.rpc_calls) == 1
        status = client.get(BASE + "/replacements").json()
        assert status["available"] and status["projection"]["provider_savings_verified"] is False
        pinned = client.post(BASE + "/pins", json={"run_id": context["run_id"], "revision": context["revision"],
                                                    "pin_version": 0, "part_ids": ["msg_calls:0:call"]})
        assert pinned.status_code == 200, pinned.text
        assert pinned.json()["pin_version"] == 1
        assert source.bundles["bundle_fixture"]["state"] == "deactivated"


def test_pin_change_and_source_drift_block_preview_activation_atomically():
    source = PluginClient()
    with TestClient(create_app(Settings(refresh_seconds=0), source, Counter()), base_url=ORIGIN) as client:
        context, draft, _ = make_draft(client)
        path = BASE + "/summary-drafts/" + draft["draft_id"]
        version = {"run_id": context["run_id"], "draft_version": 1}
        client.post(path + "/preview", json=version).raise_for_status()
        source.messages[-1]["content"][0]["state"]["content"][0]["text"] = "Changed"
        response = client.post(path + "/activate", json={**version, "pin_version": 0, "operation_id": "changed"})
        assert response.status_code == 409 and not source.bundles
        assert client.get(path, params={"run_id": context["run_id"]}).json()["stale"]
        assert not any(method == "activate" for _, method, _ in source.rpc_calls)


def test_plugin_independent_admission_and_instance_restart():
    source = PluginClient()
    source.reject = True
    with TestClient(create_app(Settings(), source, Counter()), base_url=ORIGIN) as client:
        context, draft, _ = make_draft(client)
        path = BASE + "/summary-drafts/" + draft["draft_id"]
        version = {"run_id": context["run_id"], "draft_version": 1}
        client.post(path + "/preview", json=version).raise_for_status()
        rejected = client.post(path + "/activate", json={**version, "pin_version": 0, "operation_id": "reject"})
        assert rejected.status_code == 409 and not source.bundles
        source.reject = False
        client.post(path + "/activate", json={**version, "pin_version": 0, "operation_id": "admit"}).raise_for_status()
        source.instance = "new_instance"
        source.bundles.clear()
        client.get(BASE + "/replacements").raise_for_status()
        current = client.get(path, params={"run_id": context["run_id"]}).json()
        assert current["state"] == "expired"


def test_state_actions_require_configured_host_origin_json_and_bounded_body():
    with TestClient(create_app(Settings(), PluginClient(), Counter()), base_url=ORIGIN) as client:
        context = client.get(BASE + "/context").json()
        body = {"run_id": context["run_id"], "revision": context["revision"], "pin_version": 0, "part_ids": ["msg_user:text"]}
        assert client.post(BASE + "/pins", json=body, headers={"Origin": "https://foreign.example"}).status_code == 403
        assert client.post(BASE + "/pins", json=body, headers={"Host": "foreign.example"}).status_code == 403
        assert client.post(BASE + "/pins", content=json.dumps(body), headers={"Content-Type": "text/plain"}).status_code == 415
        assert client.post(BASE + "/pins", content='"' + 'x' * 65537 + '"', headers={"Content-Type": "application/json"}).status_code == 413
        assert client.post(BASE + "/pins", json=body, headers={"Origin": ORIGIN}).status_code == 200


@pytest.mark.parametrize("native", [None, "message", "tool", "reasoning", "checkpoint"])
def test_shared_python_typescript_canonical_source_contract(native):
    root = Path(__file__).resolve().parents[1]
    fixture = json.loads((root / "tests/fixtures/source-v1.json").read_text())
    original = digest(source_record(fixture["session"], fixture["messages"]))
    if native == "message":
        fixture["messages"][1]["native"] = {"messages": []}
    elif native == "tool":
        fixture["messages"][1]["content"][1]["native"] = {}
    elif native == "reasoning":
        fixture["messages"][1]["content"].append({"type": "reasoning", "text": "Visible",
                                                "native": {"reasoningField": "reasoning_content"}})
    elif native == "checkpoint":
        fixture["messages"].insert(0, {"type": "compaction", "id": "msg_checkpoint", "status": "completed",
                                        "summary": "Summary", "metadata": {"keepID": "msg_retained", "recent": "Retained text", "other": "ignored"}})
    expected = {"guard": digest(source_record(fixture["session"], fixture["messages"])),
                "units": source_units(fixture["session"], fixture["messages"])}
    if native:
        assert expected["guard"] != original
    if native in ("message", "tool"):
        assert not expected["units"]
    script = """import {digest,sourceRecord,sourceUnits} from './plugin/dist/source.js';
import {readFileSync} from 'node:fs'; const f=JSON.parse(readFileSync(0,'utf8'));
console.log(JSON.stringify({guard:digest(sourceRecord(f.session,f.messages)),units:Object.fromEntries(sourceUnits(f.session,f.messages))}));"""
    result = subprocess.run(["node", "--input-type=module", "-e", script], cwd=root,
                            input=json.dumps(fixture), capture_output=True, text=True, check=True)
    assert json.loads(result.stdout) == expected
    for value in (float("nan"), float("inf"), 9007199254740992, "\ud800"):
        with pytest.raises(ValueError):
            digest(value)


def test_renewal_does_not_capture_history_or_depend_on_browser():
    async def exercise(app, session_id):
        store = app.state.history
        before = store.sequence
        await app.state.replacements.tick()
        assert store.sequence == before
    source = PluginClient()
    app = create_app(Settings(), source, Counter())
    with TestClient(app, base_url=ORIGIN) as client:
        context, draft, _ = make_draft(client, "Summary")
        path = BASE + "/summary-drafts/" + draft["draft_id"]
        version = {"run_id": context["run_id"], "draft_version": 1}
        client.post(path + "/preview", json=version).raise_for_status()
        client.post(path + "/activate", json={**version, "pin_version": 0, "operation_id": "admit"}).raise_for_status()
        for index in range(9):
            client.get(f"/api/sessions/ses_other{index}/context").raise_for_status()
        assert not client.get(BASE + "/history").json()["observations"]
        asyncio.run(exercise(app, "ses_example"))
        assert any(method == "renew" for _, method, _ in source.rpc_calls)
        assert source.bundles["bundle_fixture"]["state"] == "registered"


def test_generation_binding_idempotency_cancel_and_pin_staleness():
    source = PluginClient()
    with TestClient(create_app(Settings(), source, Counter()), base_url=ORIGIN) as client:
        context = client.get(BASE + "/context").json()
        body = {"run_id": context["run_id"], "revision": context["revision"], "pin_version": 0,
                "operation_id": "generate", "unit_ids": ["msg_calls:0"], "mode": "generated"}
        response = client.post(BASE + "/summary-drafts", json=body)
        assert response.status_code == 202, response.text
        draft = response.json()
        assert client.post(BASE + "/summary-drafts", json=body).json()["draft_id"] == draft["draft_id"]
        assert client.post(BASE + "/summary-drafts", json={**body, "operation_id": "concurrent"}).status_code == 429
        requests = [request for _, method, request in source.rpc_calls if method == "generate"]
        assert len(requests) == 1 and "content" not in json.dumps(requests[0])
        path = BASE + "/summary-drafts/" + draft["draft_id"]
        client.post(BASE + "/pins", json={"run_id": context["run_id"], "revision": context["revision"],
                                            "pin_version": 0, "part_ids": ["msg_calls:0:call"]}).raise_for_status()
        source.jobs["job_fixture"].update(state="completed", summaries={"msg_calls:0": "Generated text"})
        completed = client.get(path, params={"run_id": context["run_id"]}).json()
        assert completed["stale"] and completed["draft_version"] == 2
        assert client.post(path + "/preview", json={"run_id": context["run_id"], "draft_version": 2}).status_code == 409
        assert not source.bundles


def test_draft_and_control_events_are_bounded():
    source = PluginClient()
    app = create_app(Settings(), source, Counter())
    with TestClient(app, base_url=ORIGIN) as client:
        _, draft, body = make_draft(client)
        app.state.replacements.drafts.max_count = 1
        assert client.post(BASE + "/summary-drafts", json={**body, "operation_id": "extra"}).status_code == 429
        for i in range(2300):
            app.state.replacements.event(f"ses_events{i % 10}", "fixture", "Fictional control")
        events = app.state.replacements.events
        assert len(events) == 2048 and app.state.replacements.events_lost == 252
        app.state.replacements.drafts.drafts[draft["draft_id"]].created -= 1801
        app.state.replacements.drafts.expire()
        assert not app.state.replacements.drafts.drafts


def test_pending_activation_blocks_pin_until_authoritative_expiry():
    source = PluginClient()
    with TestClient(create_app(Settings(), source, Counter()), base_url=ORIGIN) as client:
        context, draft, _ = make_draft(client, "Summary")
        path = BASE + "/summary-drafts/" + draft["draft_id"]
        version = {"run_id": context["run_id"], "draft_version": 1}
        client.post(path + "/preview", json=version).raise_for_status()
        source.lose_activate = source.status_unavailable = True
        body = {**version, "pin_version": 0, "operation_id": "pending"}
        response = client.post(path + "/activate", json=body)
        assert response.status_code == 202 and response.json()["state"] == "pending"
        pin = {"run_id": context["run_id"], "revision": context["revision"], "pin_version": 0,
               "part_ids": ["msg_calls:0:result:0"]}
        assert client.post(BASE + "/pins", json=pin).json()["detail"]["code"] == "protection_pending"
        assert client.get(BASE + "/pins").json()["pin_version"] == 0
        assert client.post(path + "/activate", json=body).status_code == 202
        assert sum(method == "activate" for _, method, _ in source.rpc_calls) == 1
        source.bundles["bundle_fixture"]["state"] = "expired"
        source.status_unavailable = False
        assert client.post(BASE + "/pins", json=pin).json()["pin_version"] == 1


def test_session_move_deactivates_at_original_location_without_history_capture():
    source = PluginClient()
    app = create_app(Settings(), source, Counter())
    with TestClient(app, base_url=ORIGIN) as client:
        context, draft, _ = make_draft(client, "Summary")
        path = BASE + "/summary-drafts/" + draft["draft_id"]
        version = {"run_id": context["run_id"], "draft_version": 1}
        client.post(path + "/preview", json=version).raise_for_status()
        client.post(path + "/activate", json={**version, "pin_version": 0, "operation_id": "admit"}).raise_for_status()
        original_get = source.get
        async def moved(path, **query):
            result = await original_get(path, **query)
            if path == "/api/session/ses_example":
                result["data"]["location"] = {"directory": "/workspace/moved"}
            return result
        source.get = moved
        observed = app.state.history.sequence
        asyncio.run(app.state.replacements.tick())
        assert app.state.history.sequence == observed
        assert source.bundles["bundle_fixture"]["state"] == "deactivated"
        assert [location for location, method, _ in source.rpc_calls if method == "deactivate"] == ["/workspace/storefront"]


def test_pin_capacity_rejection_keeps_active_replacement_intact():
    source = PluginClient()
    app = create_app(Settings(), source, Counter())
    app.state.pins.limit = 1
    with TestClient(app, base_url=ORIGIN) as client:
        context, draft, _ = make_draft(client, "Summary")
        path = BASE + "/summary-drafts/" + draft["draft_id"]
        version = {"run_id": context["run_id"], "draft_version": 1}
        client.post(path + "/preview", json=version).raise_for_status()
        client.post(path + "/activate", json={**version, "pin_version": 0, "operation_id": "admit"}).raise_for_status()
        body = {"run_id": context["run_id"], "revision": context["revision"], "pin_version": 0,
                "part_ids": ["msg_calls:0:call", "msg_user:text"]}
        assert client.post(BASE + "/pins", json=body).status_code == 429
        assert source.bundles["bundle_fixture"]["state"] == "registered"
        assert not client.get(BASE + "/pins").json()["pins"]
