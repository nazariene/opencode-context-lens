import json
from collections import Counter as Counts
from copy import deepcopy

import pytest
from analysis_fixtures import MODEL, SESSION, Counter, demo_messages, message, tool

from viewer.analysis import InvalidSelection, build_analysis, preview_selection
from viewer.context import build_context


def analyze(messages, model=MODEL):
    provenance = {}
    context = build_context(SESSION, messages, model, Counter(), provenance)
    return context, build_analysis(context, provenance), provenance


def test_projection_preserves_membership_for_multiple_calls_and_result_types():
    messages = [message("assistant", "msg_tools", content=[
        tool(outputs=[{"type": "text", "text": "first"}, {"type": "text", "text": "second"},
                      {"type": "file", "name": "demo.png"}]),
        tool(status="error", outputs=[], error={"message": "missing"}),
        tool(outputs=[{"type": "text", "text": ""}]),
    ]), message("shell", "msg_shell", command="date", output="today"),
        message("skill", "msg_skill", text="Instructions")]
    context, analysis, provenance = analyze(messages)
    assert provenance["units"][0]["part_ids"] == [
        "msg_tools:0:call", "msg_tools:0:result:0", "msg_tools:0:result:1", "msg_tools:0:result:2"]
    assert provenance["units"][1]["part_ids"] == ["msg_tools:1:call", "msg_tools:1:error"]
    assert provenance["units"][2]["part_ids"] == ["msg_tools:2:call"]
    assert [unit["blocked_reason"] for unit in analysis["units"]] == ["unknown-size", "failed", "missing-result"]
    assert len(analysis["units"]) == 3
    selected = {id for unit in analysis["units"] for id in unit["part_ids"]}
    assert {part["id"] for part in context["parts"]} - selected == {"msg_shell:shell", "msg_skill:text"}
    assert "provenance" not in context


@pytest.mark.parametrize("entry,reason", [
    (tool(), None),
    (tool("skill", status="error"), "instruction-content"),
    (tool(status="error", outputs=[]), "failed"),
    (tool(status="streaming", outputs=[]), "incomplete"),
    (tool(status="new-status"), "incomplete"),
    (tool(outputs=[]), "missing-result"),
    (tool(input=""), "missing-result"),
    (tool(outputs=[{"type": "file", "name": "image.png"}]), "unknown-size"),
    (tool(outputs=[{"type": "future-format"}]), "unknown-size"),
])
def test_eligibility_and_blocker_precedence(entry, reason):
    _, analysis, _ = analyze([message("assistant", "msg_tool", content=[entry])])
    unit = analysis["units"][0]
    assert unit["blocked_reason"] == reason
    assert unit["eligible"] is (reason is None)


def test_group_partitions_resource_conservatism_and_retained_turns():
    messages = [message("compaction", "msg_checkpoint", status="completed", summary="Retained summary"),
                message("assistant", "msg_pre", content=[tool()]),
                message("user", "msg_user", text="First request"),
                message("synthetic", "msg_instructions", text="Keep this"),
                message("assistant", "msg_tools", content=[
                    tool(input={"path": "src/../cart.py"}), tool(input={"path": "/workspace/cart.py"}),
                    tool(input={"path": "cart.py", "filePath": "other.py"}),
                    tool(input={"path": "cart.py", "filePath": ""}),
                    tool(input={"filePath": "cart.py"}), tool(input={"path": "cart.py", "filePath": "cart.py"}),
                    tool("shell", input={"command": "cat cart.py"}),
                    tool(input={"path": "cart.py"}, outputs=[{"type": "file", "name": "demo.png"}]),
                ]), message("user", "msg_user2", text="Second request")]
    context, analysis, _ = analyze(messages)
    parts = {part["id"]: part for part in context["parts"]}
    for mode in ("tool", "resource", "turn"):
        groups = [group for group in analysis["groups"] if group["mode"] == mode]
        assert Counts(id for group in groups for id in group["part_ids"]) == Counts(parts.keys())
        assert sum(group["tokens"] for group in groups) == context["tokens"]
        assert sum(group["unknown_parts"] for group in groups) == context["unknown_count"]
        for group in groups:
            assert [parts[id]["order"] for id in group["part_ids"]] == sorted(parts[id]["order"] for id in group["part_ids"])
    resources = {group["label"]: group for group in analysis["groups"] if group["mode"] == "resource"}
    assert {"src/../cart.py", "/workspace/cart.py", "cart.py", "No explicit resource"} <= resources.keys()
    assert resources["cart.py"]["unit_ids"] == ["msg_tools:4", "msg_tools:5", "msg_tools:7"]
    fallback = resources["No explicit resource"]["unit_ids"]
    assert fallback == ["msg_tools:2", "msg_tools:3", "msg_tools:6"]
    turns = [group for group in analysis["groups"] if group["mode"] == "turn"]
    retained = next(group for group in turns if group["label"] == "Retained context")
    assert retained["part_ids"] == ["msg_checkpoint:summary", "msg_pre:0:call", "msg_pre:0:result:0"]
    first = next(group for group in turns if group["label"].startswith("Turn 1"))
    assert "msg_instructions:text" in first["part_ids"]


def test_exact_matching_newest_references_changed_output_and_aliases():
    inputs = {"path": "cart.py", "range": {"offset": 1, "limit": 10}}
    reordered = {"range": {"limit": 10, "offset": 1}, "path": "cart.py"}
    messages = [message("assistant", f"msg_{i}", content=[entry]) for i, entry in enumerate([
        tool(input=inputs), tool(input=reordered), tool(input=inputs),
        tool(input=inputs, outputs=[{"type": "text", "text": "Changed"}]),
        tool(input={**inputs, "offset": 2}), tool("functions.read", inputs),
    ])]
    _, analysis, _ = analyze(messages)
    duplicates = [(f["unit_id"], f["reference_unit_id"]) for f in analysis["findings"] if f["rule"] == "duplicate-result"]
    repeated = [(f["unit_id"], f["reference_unit_id"]) for f in analysis["findings"] if f["rule"] == "repeated-read"]
    assert duplicates == [("msg_0:0", "msg_2:0"), ("msg_1:0", "msg_2:0")]
    assert repeated == [("msg_0:0", "msg_3:0"), ("msg_1:0", "msg_3:0"), ("msg_2:0", "msg_3:0")]
    assert all("does not establish" in f["reason"] for f in analysis["findings"] if f["rule"] == "repeated-read")


@pytest.mark.parametrize("different", [
    {"path": "cart.py", "options": [2, 1]}, {"path": "cart.py", "options": "1,2"},
    {"path": "Cart.py", "options": [1, 2]}, {"path": "cart.py ", "options": [1, 2]},
    {"path": "cart.py", "options": [True, 2]}, {"path": "cart.py", "options": ["1", 2]},
])
def test_input_identity_preserves_values_and_order(different):
    _, analysis, _ = analyze([message("assistant", "msg_calls", content=[
        tool(input={"path": "cart.py", "options": [1, 2]}), tool(input=different)])])
    assert analysis["findings"] == []


def test_complete_output_identity_not_only_preview_or_result_count():
    prefix = "same " * 100
    _, analysis, _ = analyze([message("assistant", "msg_calls", content=[
        tool(outputs=[{"type": "text", "text": prefix + "A"}, {"type": "text", "text": "second"}]),
        tool(outputs=[{"type": "text", "text": prefix + "B"}, {"type": "text", "text": "second"}]),
        tool(outputs=[{"type": "text", "text": "second"}, {"type": "text", "text": prefix + "A"}]),
    ])])
    assert not any(f["rule"] == "duplicate-result" for f in analysis["findings"])


def test_large_result_threshold_excludes_inputs_and_overlapping_findings_count_once():
    context, analysis, _ = analyze([message("assistant", "msg_calls", content=[
        tool("shell", {"command": "input " * 5000}, [{"type": "text", "text": "out " * 4095}]),
        tool("shell", {}, [{"type": "text", "text": "out " * 4096}]),
        tool("shell", {}, [{"type": "text", "text": "out " * 4096}]),
    ])])
    large = [f["unit_id"] for f in analysis["findings"] if f["rule"] == "large-result"]
    assert large == ["msg_calls:1", "msg_calls:2"]
    ids = [f["unit_id"] for f in analysis["findings"]]
    assert ids.count("msg_calls:1") == 2
    preview = preview_selection(context, analysis, ids)
    assert preview["selected_estimated_tokens"] == 8194
    assert len(preview["selected_part_ids"]) == 4


def test_preview_is_unique_whole_call_arithmetic_without_mutation():
    context, analysis, _ = analyze(demo_messages())
    before = deepcopy((context, analysis))
    preview = preview_selection(context, analysis, ["msg_new:1", "msg_old:0", "msg_old:0"])
    members = [part for part in context["parts"] if part["id"] in preview["selected_part_ids"]]
    selected = sum(part["tokens"] for part in members)
    assert preview["selected_unit_ids"] == ["msg_old:0", "msg_new:1"]
    assert preview["selected_part_ids"] == ["msg_old:0:call", "msg_old:0:result:0", "msg_new:1:call", "msg_new:1:result:0"]
    assert preview["selected_estimated_tokens"] == selected
    assert preview["after_visible_tokens"] == context["tokens"] - selected
    assert preview["selected_visible_percent"] == round(100 * selected / context["tokens"], 2)
    assert preview["selected_window_percent"] == round(100 * selected / MODEL["limit"]["context"], 2)
    assert preview["unmeasured_parts"] == 2
    assert preview["mode"] == "hypothetical" and preview["applies_changes"] is False
    assert (context, analysis) == before


def test_invalid_selections_reject_all_and_classify_unique_ids():
    context, analysis, _ = analyze(demo_messages())
    with pytest.raises(InvalidSelection) as error:
        preview_selection(context, analysis, ["msg_old:0", "msg_old:0:call", "missing", "missing", "msg_blocked:0"])
    assert error.value.detail["unknown_unit_ids"] == ["missing", "msg_old:0:call"]
    assert error.value.detail["ineligible_unit_ids"] == ["msg_blocked:0"]


def test_empty_and_unknown_denominators():
    context, analysis, _ = analyze([], model=None)
    assert analysis["units"] == analysis["groups"] == analysis["findings"] == []
    preview = preview_selection(context, analysis, [])
    assert preview["selected_estimated_tokens"] == preview["after_visible_tokens"] == 0
    assert preview["selected_visible_percent"] is None
    assert preview["selected_window_percent"] is None
    assert preview["after_window_percent"] is None
    context, analysis, _ = analyze(demo_messages(), model=None)
    preview = preview_selection(context, analysis, [])
    assert preview["selected_visible_percent"] == 0
    assert preview["after_visible_tokens"] == context["tokens"]


def test_revision_covers_analysis_inputs_but_not_timestamps_and_provider_counters():
    messages = demo_messages()
    original = build_context(SESSION, messages, MODEL, Counter())["revision"]
    messages[0]["time"]["created"] = 999
    messages[3]["tokens"]["input"] = 900
    assert build_context(SESSION, messages, MODEL, Counter())["revision"] == original
    messages[-1]["content"][1]["state"]["status"] = "completed"
    assert build_context(SESSION, messages, MODEL, Counter())["revision"] != original
    assert build_context(SESSION, [], MODEL, Counter())["revision"] != build_context(SESSION, [], None, Counter())["revision"]
    counter = Counter()
    counter.method = "fallback"
    assert build_context(SESSION, [], MODEL, Counter())["revision"] != build_context(SESSION, [], MODEL, counter)["revision"]


def test_analysis_is_deterministic_and_does_not_expose_private_bodies():
    _, first, _ = analyze(demo_messages())
    _, second, _ = analyze(demo_messages())
    assert first == second
    encoded = json.dumps(first)
    assert "private-base64" not in encoded and "Passing checkout test" not in encoded
    assert '"command"' not in encoded and '"input"' not in encoded and '"text"' not in encoded
