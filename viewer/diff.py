from collections import Counter


def measurement(context):
    return {key: context[key] for key in ("tokens", "unknown_count", "window", "window_percent",
                                        "tokenizer", "categories", "reported", "model")}


def compare_snapshots(before, after):
    def indexed(record, side):
        return {record.provenance["sources"][part["id"]]["key"] or (side, part["id"]): part
                for part in record.context["parts"]}

    def summary(part):
        return {name: value for name, value in part.items() if name != "text"} if part else None

    # An observation compared with itself also matches its ambiguous local parts.
    old = indexed(before, "same" if before is after else "before")
    new = indexed(after, "same" if before is after else "after")
    rows = []
    for key in dict.fromkeys([*old, *new]):
        left, right = old.get(key), new.get(key)
        flags = {"text_changed": False, "metadata_changed": False,
                 "order_changed": False, "measurement_changed": False}
        if left is None:
            kind = "added"
        elif right is None:
            kind = "removed"
        else:
            flags = {
                "text_changed": left["text"] != right["text"],
                "metadata_changed": any(left[field] != right[field] for field in ("category", "title", "note"))
                or before.provenance["sources"][left["id"]]["status"]
                != after.provenance["sources"][right["id"]]["status"],
                "order_changed": left["order"] != right["order"],
                "measurement_changed": left["tokens"] != right["tokens"]
                or before.context["tokenizer"] != after.context["tokenizer"]
                or before.context["window"] != after.context["window"]
                or before.context["session"].get("model") != after.context["session"].get("model"),
            }
            kind = "changed" if any(flags.values()) else "unchanged"
        rows.append({"kind": kind, **flags, "before": summary(left), "after": summary(right),
                     "known_delta": ((right["tokens"] or 0) if right else 0)
                     - ((left["tokens"] or 0) if left else 0)})
    counts = Counter(row["kind"] for row in rows)
    category_ids = dict.fromkeys([category["id"] for record in (before, after) for category in record.context["categories"]])
    categories = []
    for category in category_ids:
        sides = [{entry["id"]: entry for entry in record.context["categories"]}.get(category, {}) for record in (before, after)]
        categories.append({"id": category, "name": (sides[1] or sides[0])["name"],
                           "before_known": sides[0].get("tokens", 0), "after_known": sides[1].get("tokens", 0),
                           "known_delta": sides[1].get("tokens", 0) - sides[0].get("tokens", 0),
                           "unknown_delta": sides[1].get("unknown", 0) - sides[0].get("unknown", 0)})
    return {"before": measurement(before.context), "after": measurement(after.context), "rows": rows,
            "categories": categories,
            "counts": {kind: counts[kind] for kind in ("added", "removed", "changed", "unchanged")},
            "known_delta": after.context["tokens"] - before.context["tokens"],
            "unknown_delta": after.context["unknown_count"] - before.context["unknown_count"]}
