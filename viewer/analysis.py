import json

from .context import ANALYSIS_RULESET, percentage


def declared_resource(tool_input):
    if not isinstance(tool_input, dict):
        return None
    paths = [tool_input[key] for key in ("path", "filePath") if key in tool_input]
    if not paths or any(not isinstance(path, str) or not path for path in paths):
        return None
    if any(path != paths[0] for path in paths):
        return None
    return {"kind": "path", "value": paths[0]}


def blocked_reason(source, members):
    if any(part["category"] in ("instructions", "skills") for part in members):
        return "instruction-content"
    if source["status"] == "error":
        return "failed"
    if source["status"] != "completed":
        return "incomplete"
    if not source["input_ids"] or not source["result_ids"]:
        return "missing-result"
    if any(part["tokens"] is None for part in members):
        return "unknown-size"
    return None


def build_analysis(context, provenance):
    parts = {part["id"]: part for part in context["parts"]}
    units = []
    part_units = {}
    for source in provenance["units"]:
        members = [parts[id] for id in source["part_ids"]]
        reason = blocked_reason(source, members)
        resource = declared_resource(source["input"])
        unit = {key: source[key] for key in ("id", "tool_name", "status", "part_ids", "turn_id")}
        unit.update(label=f"{source['tool_name']} · {resource['value']}" if resource else source["tool_name"],
                    resource=resource, tokens=sum(part["tokens"] or 0 for part in members),
                    unknown_parts=sum(part["tokens"] is None for part in members),
                    eligible=reason is None, blocked_reason=reason)
        units.append(unit)
        part_units.update((id, unit) for id in unit["part_ids"])

    groups = {}
    group_units = {}
    for part in context["parts"]:
        unit = part_units.get(part["id"])
        resource = unit["resource"] if unit else None
        turn = provenance["part_turns"][part["id"]]
        memberships = [
            ("tool", unit["tool_name"] if unit else None, unit["tool_name"] if unit else "Non-tool context"),
            ("resource", resource["value"] if resource else None,
             resource["value"] if resource else "No explicit resource"),
            ("turn", turn, provenance["turns"][turn]),
        ]
        for mode, key, label in memberships:
            identity = (mode, key)
            if identity not in groups:
                groups[identity] = {"id": f"group:{mode}:{len(groups)}", "mode": mode, "label": label,
                                    "part_ids": [], "unit_ids": [], "tokens": 0, "unknown_parts": 0}
                group_units[identity] = set()
            group = groups[identity]
            group["part_ids"].append(part["id"])
            group["tokens"] += part["tokens"] or 0
            group["unknown_parts"] += part["tokens"] is None
            if unit and unit["id"] not in group_units[identity]:
                group_units[identity].add(unit["id"])
                group["unit_ids"].append(unit["id"])

    findings = []
    duplicate_index, read_index = {}, {}

    def finding(rule, unit, source, reason, reference=None):
        findings.append({
            "id": f"{rule}:{unit['id']}", "rule": rule, "unit_id": unit["id"],
            "reference_unit_id": reference["id"] if reference else None,
            "reason": reason, "estimated_tokens": unit["tokens"],
            "evidence_part_ids": (source["part_ids"] + reference["part_ids"] if reference
                                  else source["result_ids"]),
        })

    # Dict keys hash the complete values and verify equality on collisions. Walking
    # backwards retains the newest match without comparing every pair of outputs.
    for unit, source in reversed(list(zip(units, provenance["units"]))):
        if not unit["eligible"]:
            continue
        canonical_input = json.dumps(source["input"], sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        input_key = (unit["tool_name"], canonical_input)
        output_key = (*input_key, tuple(parts[id]["text"] for id in source["result_ids"]))
        reference = duplicate_index.get(output_key)
        if reference:
            finding("duplicate-result", unit, source,
                    "A later invocation has the same tool, arguments, and exactly equal visible text results.", reference)
        else:
            duplicate_index[output_key] = source
        if unit["tool_name"] in ("read", "functions.read") and unit["resource"]:
            reference = read_index.get(input_key)
            if reference:
                finding("repeated-read", unit, source,
                        "The same path was read again with matching arguments. "
                        "Repeated access does not establish obsolete content.", reference)
            else:
                read_index[input_key] = source
        result_tokens = sum(parts[id]["tokens"] for id in source["result_ids"])
        if result_tokens >= 4096:
            finding("large-result", unit, source,
                    f"The result contains approximately {result_tokens:,} tokens, "
                    "at or above the 4,096-token review threshold.")

    order = {unit["id"]: index for index, unit in enumerate(units)}
    findings.sort(key=lambda finding: (-finding["estimated_tokens"], order[finding["unit_id"]]))
    return {"session_id": context["session"]["id"], "revision": context["revision"],
            "ruleset": ANALYSIS_RULESET, "units": units, "findings": findings,
            "groups": sorted(groups.values(), key=lambda group: (-group["tokens"], parts[group["part_ids"][0]]["order"]))}


class InvalidSelection(ValueError):
    def __init__(self, unknown, ineligible):
        super().__init__("Select eligible complete tool units from this snapshot.")
        self.detail = {"code": "invalid_selection", "message": str(self),
                       "unknown_unit_ids": sorted(unknown), "ineligible_unit_ids": sorted(ineligible)}


def preview_selection(context, analysis, unit_ids):
    selected = set(unit_ids)
    units = {unit["id"]: unit for unit in analysis["units"]}
    unknown = selected - units.keys()
    ineligible = {id for id in selected & units.keys() if not units[id]["eligible"]}
    if unknown or ineligible:
        raise InvalidSelection(unknown, ineligible)
    members = {part for id in selected for part in units[id]["part_ids"]}
    parts = [part for part in context["parts"] if part["id"] in members]
    tokens = sum(part["tokens"] for part in parts)
    before, window = context["tokens"], context["window"]
    return {
        "session_id": context["session"]["id"], "revision": context["revision"],
        "mode": "hypothetical", "applies_changes": False, "scope": "visible-text-only",
        "tokenizer": context["tokenizer"], "selected_unit_ids": [id for id in units if id in selected],
        "selected_part_ids": [part["id"] for part in parts], "before_visible_tokens": before,
        "selected_estimated_tokens": tokens, "after_visible_tokens": before - tokens,
        "selected_visible_percent": percentage(tokens, before), "window_tokens": window,
        "selected_window_percent": percentage(tokens, window), "after_window_percent": percentage(before - tokens, window),
        "unmeasured_parts": context["unknown_count"],
    }
