"""Dashboard boundary checks; canonical pruning semantics are tested in the plugin."""
import json
from copy import deepcopy

from analysis_fixtures import SESSION, Counter, tool
from fastapi.testclient import TestClient
from test_summaries import BASE, ORIGIN, PluginClient

from viewer.client import OpenCodeError, PluginRejected
from viewer.server import create_app
from viewer.settings import Settings
from viewer.source import digest, source_record


class PruningClient(PluginClient):
    def __init__(self, count=2):
        super().__init__()
        self.messages[-1]["time"]["completed"] = 2
        self.messages[-1]["content"] = [
            {**tool(outputs=[{"type": "text", "text": f"Fictional result {i}"}]), "id": f"call_{i}"}
            for i in range(count)] + [{"type": "reasoning", "text": "Fictional reasoning <script>window.unsafe=true</script>"}]
        self.revision = 0
        self.edits = []
        self.previews = {}
        self.protected = []
        self.receipts = {}
        self.lose_apply = False
        self.last_compaction = None
        if count > 2:
            self.messages[-1]["content"][count-1]["state"]["input"] = {"fictional_large_argument": "x" * 17000}

    async def rpc(self, location, method, body):
        if method == "capabilities":
            return {**await super().rpc(location, method, body), "pruning": 1}
        if not method.startswith("pruning"):
            return await super().rpc(location, method, body)
        self.rpc_calls.append((location, method, deepcopy(body)))
        if body["instance_id"] != self.instance:
            raise PluginRejected("instance_changed", "Plugin restarted")
        targets = []
        for i, part in enumerate(self.messages[-1]["content"]):
            tool_part = part["type"] == "tool"
            text = part["state"]["content"][0]["text"] if tool_part else part["text"]
            id = f"target_{i}"
            edit = next((edit for edit in self.edits if edit["target_id"] == id), None)
            targets.append({"id": id, "message_id": "msg_calls", "kind": part["type"], "call_id": part.get("id"),
                            "title": part.get("name", "Visible reasoning"), "part_ids": [f"msg_calls:{i}:call", f"msg_calls:{i}:result:0"] if tool_part else [f"msg_calls:{i}"],
                            "reason": None, "preview": text, "characters": len(text), "pinned": id in self.protected,
                            "bytes": len(text.encode()) + (len(json.dumps(part["state"]["input"]).encode()) if tool_part else 0),
                            "edit": edit, "effective_preview": "[Output pruned]" if edit else text, "summary_conflict": False})
        for message in self.messages:
            id = "range_" + message["id"]
            text = message.get("text", "Fictional assistant range source")
            part_ids = [part for target in targets if target["message_id"] == message["id"] for part in target["part_ids"]] if message["type"] == "assistant" else [message["id"] + ":text"]
            edit = next((edit for edit in self.edits if edit["target_id"] == id), None)
            targets.append({"id": id, "message_id": message["id"], "kind": "message", "call_id": None,
                            "title": message["type"] + " · " + text, "part_ids": part_ids,
                            "reason": None, "preview": text, "characters": len(text), "bytes": len(text.encode()),
                            "pinned": id in self.protected, "edit": edit, "effective_preview": "[Omitted]" if edit else text, "summary_conflict": False})
        guard = digest(source_record({**SESSION, "id": body["session_id"]}, self.messages))
        if method == "pruningInspect":
            return {"version": 1, "session_id": body["session_id"], "revision": self.revision, "source_guard": guard,
                    "enabled": True, "reason": None, "edits": deepcopy(self.edits), "targets": targets, "evidence": None,
                    "last_compaction": self.last_compaction}
        if method == "pruningProtect":
            if any(edit["target_id"] in body["target_ids"] for edit in self.edits):
                raise PluginRejected("pruning_conflict", "Restore pruning before pinning")
            self.protected = body["target_ids"]
            return {"pin_version": body["pin_version"]}
        if method == "pruningPreview":
            if body["source_guard"] != guard or body["revision"] != self.revision:
                raise PluginRejected("source_changed", "Source changed")
            selected = [target for target in targets if target["id"] in body["target_ids"]]
            if len(selected) != len(set(body["target_ids"])) or any(target["pinned"] for target in selected):
                raise PluginRejected("invalid_selection", "Selection is protected or unknown")
            preview_id = f"preview_{len(self.previews)}"
            preview = {"preview_id": preview_id, "revision": self.revision, "source_guard": guard, "expires_at": 9999999999999,
                       "rows": [{"target_id": target["id"], "title": target["title"], "action": body["action"], "expanded": False,
                                 "before": target["preview"], "after": "[Output pruned]" if body["action"] == "prune-result" else
                                 "Fictional range summary <script>window.unsafe=true</script>" if body["action"].startswith("summarize-") and target == selected[0] else ""} for target in selected],
                       "expanded_count": 0, "applies_changes": False}
            self.previews[preview_id] = preview
            return deepcopy(preview)
        if method == "pruningApply":
            if body["operation_id"] not in self.receipts:
                preview = self.previews[body["preview_id"]]
                if preview["source_guard"] != guard:
                    raise PluginRejected("source_changed", "Source changed after preview")
                self.edits.extend({"target_id": row["target_id"], "action": row["action"], "group_id": body["operation_id"]} for row in preview["rows"])
                self.revision += 1
                self.receipts[body["operation_id"]] = True
            if self.lose_apply:
                raise OpenCodeError("Lost acknowledgment")
        if method == "pruningRestore":
            if body["revision"] != self.revision:
                raise PluginRejected("policy_changed", "Policy changed")
            self.edits = [edit for edit in self.edits if edit["group_id"] not in body["group_ids"]]
            self.revision += 1
        return {"revision": self.revision, "edits": deepcopy(self.edits), "saved": True}


def preview(client):
    context = client.get(BASE + "/context").json()
    status = client.get(BASE + "/pruning").json()
    body = {key: status[key] for key in ("run_id", "instance_id", "snapshot_revision", "pin_version", "revision", "source_guard")}
    response = client.post(BASE + "/pruning/preview", json={**body, "action": "prune-result", "target_ids": ["target_0"]})
    assert response.status_code == 200, response.text
    return context, response.json(), {"run_id": status["run_id"], "instance_id": status["instance_id"],
                                      "pin_version": status["pin_version"], "preview_id": response.json()["preview_id"], "operation_id": "apply"}


def test_preview_apply_lost_ack_restart_restore_and_original_history():
    source = PruningClient()
    original = deepcopy(source.messages)
    with TestClient(create_app(Settings(), source, Counter()), base_url=ORIGIN) as client:
        _, reviewed, body = preview(client)
        assert reviewed["before_tokens"] == 3 and reviewed["after_tokens"] == 2
        assert not source.edits
        source.lose_apply = True
        assert client.post(BASE + "/pruning/apply", json=body).status_code == 502
        source.lose_apply = False
        assert client.post(BASE + "/pruning/apply", json=body).json()["revision"] == 1
        assert len(source.edits) == 1
    with TestClient(create_app(Settings(), source, Counter()), base_url=ORIGIN) as client:
        status = client.get(BASE + "/pruning").json()
        assert status["available"] and status["run_id"] != body["run_id"] and len(status["edits"]) == 1
        restored = client.post(BASE + "/pruning/restore", json={"run_id": status["run_id"], "instance_id": source.instance,
                               "revision": 1, "group_ids": ["apply"], "operation_id": "restore"})
        assert restored.status_code == 200, restored.text
        assert not restored.json()["edits"]
    assert source.messages == original


def test_pins_block_apply_and_pruned_content_cannot_be_pinned():
    source = PruningClient()
    with TestClient(create_app(Settings(), source, Counter()), base_url=ORIGIN) as client:
        context, _, body = preview(client)
        pin = {"run_id": context["run_id"], "revision": context["revision"], "pin_version": 0, "part_ids": ["msg_calls:0:result:0"]}
        pinned = client.post(BASE + "/pins", json=pin)
        assert pinned.status_code == 200, pinned.text
        assert source.protected == ["target_0", "range_msg_calls"]
        assert client.post(BASE + "/pruning/apply", json=body).status_code == 409
        pin_id = pinned.json()["pins"][0]["id"]
        client.request("DELETE", BASE + "/pins/" + pin_id, json={"run_id": context["run_id"], "pin_version": 1}).raise_for_status()
        assert not source.protected
        _, _, body = preview(client)
        client.post(BASE + "/pruning/apply", json=body).raise_for_status()
        refused = client.post(BASE + "/pins", json={**pin, "pin_version": 2})
        assert refused.status_code == 422 and not client.get(BASE + "/pins").json()["pins"]


def test_pruning_admission_origin_run_source_and_instance_guards():
    source = PruningClient()
    with TestClient(create_app(Settings(refresh_seconds=0), source, Counter()), base_url=ORIGIN) as client:
        _, _, body = preview(client)
        assert client.post(BASE + "/pruning/apply", json=body, headers={"Origin": "https://foreign.example"}).status_code == 403
        assert client.post(BASE + "/pruning/apply", content="{}", headers={"Content-Type": "text/plain"}).status_code == 415
        assert client.post(BASE + "/pruning/apply", json={**body, "run_id": "old"}).status_code == 409
        source.messages[-1]["content"][0]["state"]["content"][0]["text"] = "Changed"
        assert client.post(BASE + "/pruning/apply", json=body).status_code == 409
        source.instance = "plugin_restarted"
        assert client.post(BASE + "/pruning/apply", json=body).status_code == 409
        assert not source.edits


def test_old_plugin_leaves_dashboard_usable_with_pruning_unavailable():
    with TestClient(create_app(Settings(), PluginClient(), Counter()), base_url=ORIGIN) as client:
        status = client.get(BASE + "/pruning").json()
        assert status["available"] is False
        assert "Rebuild" in status["reason"]
        client.get(BASE + "/context").raise_for_status()


def test_range_summary_relay_uses_authoritative_preview_and_pin_guards():
    source = PruningClient()
    with TestClient(create_app(Settings(), source, Counter()), base_url=ORIGIN) as client:
        status = client.get(BASE + "/pruning").json()
        body = {key: status[key] for key in ("run_id", "instance_id", "snapshot_revision", "pin_version", "revision", "source_guard")}
        for action in ("delete-range", "summarize-brief", "summarize-full"):
            result = client.post(BASE + "/pruning/preview", json={**body, "action": action, "target_ids": ["range_msg_user", "range_msg_calls"]})
            assert result.status_code == 200, result.text
            assert len(result.json()["rows"]) == 2
            assert bool(result.json()["rows"][0]["after"]) == action.startswith("summarize-")
            assert source.rpc_calls[-1][1:] == ("pruningPreview", {key: value for key, value in {
                **body, "session_id": "ses_example", "action": action, "target_ids": ["range_msg_user", "range_msg_calls"]}.items()
                if key not in ("snapshot_revision", "pin_version")})
        assert not source.edits
