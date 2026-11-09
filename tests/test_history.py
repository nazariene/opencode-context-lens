from copy import deepcopy
from dataclasses import replace

import pytest
from analysis_fixtures import MODEL, SESSION, Counter, message, tool

from viewer.diff import compare_snapshots
from viewer.history import History, ReviewError
from viewer.server import build_snapshot
from viewer.settings import Settings


def record(text="First result", session=SESSION):
    return build_snapshot(session, [message("user", "msg_user", text=text)], MODEL, Counter())


def test_observation_identity_dedup_return_and_shared_payloads():
    history = History(Settings())
    first, second = record(), record("A new result")
    a = history.observe(first, 100, 1)
    assert history.observe(record(), 200, 2) == a
    assert history.summary(SESSION["id"])["observations"][0]["last_observed"] == 200
    b = history.observe(second, 300, 3)
    c = history.observe(record(), 400, 4)
    assert len({a, b, c}) == 3 and len(history.payloads) == 2
    assert history.get(SESSION["id"], history.run_id, a)[1] is first
    expected = first.payload_bytes + second.payload_bytes
    expected += sum(history._metadata_bytes(o) for o in history.observations.values())
    assert history.bytes == expected


def test_retention_limits_and_oversize_do_not_truncate():
    history = History(Settings(history_snapshots_per_session=2, history_sessions=1))
    oldest = history.observe(record("one"))
    history.observe(record("two"))
    history.observe(record("three"))
    assert history.summary(SESSION["id"])["evicted"] == 1
    with pytest.raises(ReviewError) as error:
        history.get(SESSION["id"], history.run_id, oldest)
    assert error.value.status == 410
    history.observe(record(session={**SESSION, "id": "ses_other"}))
    assert len(history.sessions) == 1 and history.evicted_sessions == 1
    tiny = History(Settings(history_max_bytes=1))
    assert tiny.observe(record()) is None
    assert tiny.bytes == 0 and tiny.summary(SESSION["id"])["skipped"] == 1


def test_byte_budget_session_validation_and_restart():
    a, b = record("one"), record("two")
    history = History(Settings(history_max_bytes=a.payload_bytes + 400))
    old = history.observe(a)
    current = history.observe(b)
    assert old not in history.observations and current in history.observations
    assert history.bytes <= history.settings.history_max_bytes
    with pytest.raises(ReviewError, match="same session"):
        history.get("ses_other", history.run_id, current)
    with pytest.raises(ReviewError, match="restarted"):
        history.get(SESSION["id"], History(Settings()).run_id, current)


def test_native_identity_preserves_parts_across_reordering_and_output_changes():
    calls = [{**tool(), "id": "call_a"}, {**tool(), "id": "call_b"}]
    messages = [message("assistant", "msg_tools", content=calls)]
    before = build_snapshot(SESSION, messages, MODEL, Counter())
    changed = deepcopy(messages)
    changed[0]["content"].reverse()
    changed[0]["content"][1]["state"]["content"][0]["text"] = "Changed result"
    after = build_snapshot(SESSION, changed, MODEL, Counter())
    assert before.context["parts"][0]["id"] == "msg_tools:0:call"
    assert before.provenance["units"][0]["call_id"] == "call_a"
    diff = compare_snapshots(before, after)
    assert diff["counts"]["added"] == diff["counts"]["removed"] == 0
    assert sum(row["text_changed"] for row in diff["rows"]) == 1
    assert all(row["order_changed"] for row in diff["rows"])
    assert sum(row["known_delta"] for row in diff["rows"]) == diff["known_delta"]


def test_ambiguous_native_and_non_tool_identities_do_not_match_by_equal_text():
    for content in ([tool(), tool()], [{**tool(), "id": "repeat"}, {**tool(), "id": "repeat"}],
                    [{"type": "text", "text": "same"}, {"type": "text", "text": "same"}]):
        messages = [message("assistant", "msg_tools", content=content)]
        before = build_snapshot(SESSION, messages, MODEL, Counter())
        after = build_snapshot(SESSION, messages, MODEL, Counter())
        assert all(source["key"] is None for source in before.provenance["sources"].values())
        diff = compare_snapshots(before, after)
        assert diff["counts"]["added"] == diff["counts"]["removed"] == len(before.context["parts"])
        assert compare_snapshots(before, before)["counts"]["unchanged"] == len(before.context["parts"])


def test_diff_measurement_unknowns_reverse_and_independent_equal_text():
    before = record("same")
    messages = [message("user", "msg_user", text="same"), message("user", "msg_other", text="same",
                files=[{"name": "image", "mime": "image/png"}])]
    after = build_snapshot(SESSION, messages, {**MODEL, "limit": {"context": 200000}}, Counter())
    diff = compare_snapshots(before, after)
    assert diff["counts"] == {"added": 2, "removed": 0, "changed": 1, "unchanged": 0}
    assert diff["unknown_delta"] == 1
    assert diff["rows"][0]["measurement_changed"] and not diff["rows"][0]["text_changed"]
    assert compare_snapshots(after, before)["known_delta"] == -diff["known_delta"]
    assert all("text" not in (row["after"] or {}) for row in diff["rows"])


def test_unknown_to_known_results_reconcile_categories_and_preserve_multi_result_identity():
    messages = [message("assistant", "msg_tools", content=[{**tool(outputs=[
        {"type": "file", "name": "fictional.png", "mime": "image/png"},
        {"type": "text", "text": "Retained result"}]), "id": "call_multi"}])]
    before = build_snapshot(SESSION, messages, MODEL, Counter())
    changed = deepcopy(messages)
    changed[0]["content"][0]["state"]["content"][0] = {"type": "text", "text": "Now readable"}
    after = build_snapshot(SESSION, changed, MODEL, Counter())
    comparison = compare_snapshots(before, after)
    assert comparison["counts"] == {"added": 0, "removed": 0, "changed": 1, "unchanged": 2}
    transition = next(row for row in comparison["rows"] if row["kind"] == "changed")
    assert transition["before"]["tokens"] is None and transition["after"]["tokens"] == 2
    assert comparison["unknown_delta"] == -1
    assert sum(category["known_delta"] for category in comparison["categories"]) == comparison["known_delta"]
    assert sum(category["unknown_delta"] for category in comparison["categories"]) == -1
    assert sum(category["before_known"] for category in comparison["categories"]) == before.context["tokens"]
    assert sum(category["after_known"] for category in comparison["categories"]) == after.context["tokens"]


def test_capture_gaps_checkpoints_usage_and_skipped_intermediate_revision():
    history = History(Settings(refresh_seconds=5))
    initial = record()
    first = history.observe(initial, 100, 1)
    observed = record()
    observed.context["reported"] = {"input": 123}
    assert history.observe(observed, 200, 20) == first
    observation, frozen = history.get(SESSION["id"], history.run_id, first)
    assert observation.gap and observation.reported == {"input": 123}
    assert frozen.context["reported"] is None
    checkpoint = build_snapshot(SESSION, [message("compaction", "msg_checkpoint", status="completed", summary="Short summary")], MODEL, Counter())
    assert history.get(SESSION["id"], history.run_id, history.observe(checkpoint, 300, 21))[0].compaction
    oversized = replace(record("large"), payload_bytes=history.settings.history_max_bytes + 1)
    assert history.observe(oversized, 400, 22) is None
    returned = history.observe(checkpoint, 500, 23)
    assert returned != history.summary(SESSION["id"])["observations"][-2]["snapshot_id"]
    assert not history.get(SESSION["id"], history.run_id, returned)[0].compaction
