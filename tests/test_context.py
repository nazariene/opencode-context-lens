import json

import pytest

from viewer.context import TokenCounter, build_context


class Counter:
    method = "test word estimate"

    def count(self, text):
        return len(text.split())


SESSION = {"id": "ses_test", "title": "Example", "model": {"id": "example", "providerID": "test"},
           "tokens": {"input": 9_000_000}, "location": {"directory": "/project"}}
MODEL = {"id": "example", "providerID": "test", "name": "Example Model", "limit": {"context": 1000}}


def message(kind, id="msg_one", **values):
    return {"id": id, "type": kind, "time": {"created": 1}, **values}


def test_provider_usage_is_latest_completed_input_including_cache_not_cumulative():
    messages = [message("user", text="one two three"), message(
        "assistant", "msg_reply", model=SESSION["model"], time={"created": 2, "completed": 3},
        content=[{"type": "text", "text": "four five"}],
        tokens={"input": 100, "output": 50, "reasoning": 10, "cache": {"read": 200, "write": 20}}),
        message("assistant", "msg_stream", tokens={"input": 999}, content=[])]
    context = build_context(SESSION, messages, MODEL, Counter())
    assert context["reported"]["input"] == 320
    assert context["reported"]["percent"] == 32
    assert context["tokens"] == 5
    assert context["window_percent"] == .5
    assert sum(part["percent"] for part in context["parts"]) == 100
    assert [part["tokens"] for part in context["parts"]] == [3, 2]


def test_media_and_encrypted_reasoning_do_not_become_text_tokens():
    messages = [message("user", text="Look", files=[{"name": "photo.png", "mime": "image/png", "data": "base64" * 500}]),
                message("assistant", "msg_reply", content=[{"type": "reasoning", "text": "",
                    "state": {"reasoningEncryptedContent": "ciphertext" * 500}}])]
    context = build_context(SESSION, messages, MODEL, Counter())
    assert context["tokens"] == 1
    assert context["unknown_count"] == 2
    assert context["opaque_count"] == 1
    assert "ciphertext" not in json.dumps(context)
    assert "base64" not in json.dumps(context)
    assert context["parts"][1]["percent"] is None


def test_compaction_checkpoint_and_post_compaction_content_only():
    messages = [message("compaction", status="completed", summary="Prior summary", recent="Recent record"),
                message("user", "msg_new", text="Continue here"),
                message("model-switched", "msg_control", model=SESSION["model"]),
                message("idle", "msg_idle"),
                message("compaction", "msg_running", status="running")]
    context = build_context(SESSION, messages, MODEL, Counter())
    assert context["tokens"] == 6
    assert context["part_count"] == 3
    assert context["reported"] is None
    assert context["excluded"] == {"model-switched": 1, "idle": 1, "unfinished compaction": 1}


def test_tool_calls_results_skills_errors_and_partial_inputs():
    messages = [message("assistant", content=[
        {"type": "tool", "name": "skill", "state": {"status": "completed", "input": {"id": "guide"},
            "content": [{"type": "text", "text": "Skill instructions"}]}},
        {"type": "tool", "name": "read", "state": {"status": "error", "input": {"path": "/missing"},
            "error": {"message": "File missing"}}},
        {"type": "tool", "name": "shell", "state": {"status": "streaming", "input": '{"command":'}},
    ])]
    context = build_context(SESSION, messages, MODEL, Counter())
    by_category = {category["id"]: category for category in context["categories"]}
    assert by_category["calls"]["count"] == 3
    assert by_category["skills"]["tokens"] == 2
    assert by_category["tools"]["count"] == 1
    assert context["parts"][-1]["text"] == '{"command":'
    assert len({part["id"] for part in context["parts"]}) == len(context["parts"])


def test_previous_model_usage_has_no_current_window_percentage():
    messages = [message("assistant", model={"id": "old", "providerID": "test"}, content=[],
                        time={"created": 1, "completed": 2}, tokens={"input": 100})]
    context = build_context(SESSION, messages, MODEL, Counter())
    assert context["reported"]["input"] == 100
    assert context["reported"]["percent"] is None
    assert not context["reported"]["same_model"]


def test_unknown_window_empty_context_and_model_private_fields():
    context = build_context(SESSION, [], None, Counter())
    assert context["window"] is None
    assert context["window_percent"] is None
    assert context["tokens"] == 0
    model = dict(MODEL, headers={"Authorization": "private"})
    assert "headers" not in build_context(SESSION, [], model, Counter())["model"]


def test_tokenizer_fallback_is_labeled_and_counts_unicode_bytes(monkeypatch):
    def unavailable(name):
        raise OSError("Offline")
    monkeypatch.setattr("viewer.context.tiktoken.get_encoding", unavailable)
    counter = TokenCounter()
    assert "unavailable" in counter.method
    assert counter.count("你好") == 2
    assert counter.count("") == 0


@pytest.mark.parametrize("extra", [{"providerContext": {"messages": ["opaque"]}}, {}])
def test_native_checkpoint_is_unknown_not_serialized_as_measured_text(extra):
    context = build_context(SESSION, [message("compaction", status="completed", summary="Summary", recent="", **extra)], MODEL, Counter())
    assert context["tokens"] == 1
    assert context["unknown_count"] == bool(extra)
