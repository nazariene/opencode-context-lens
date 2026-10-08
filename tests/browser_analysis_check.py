"""Run the real dashboard against fictional data, including delayed/error responses."""
import json
import shutil
import socket
import sys
import threading
from pathlib import Path

import httpx
import uvicorn
from playwright.sync_api import expect, sync_playwright

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from analysis_fixtures import Counter, DemoClient, demo_messages, message, tool

from viewer.server import create_app
from viewer.settings import Settings


def exercise(page, base, source):
    errors, part_requests = [], []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.on("request", lambda request: part_requests.append(request.url) if "/part?" in request.url else None)
    page.goto(base + "/?session=ses_example")
    expect(page.locator("#candidate-count")).to_have_text("2")
    page.locator("#live").click()
    expect(page.locator("#snapshot-age")).to_contain_text("Paused snapshot")
    expect(page.locator("#reported-tokens")).to_have_text("1,000")
    old = page.locator('.candidate[data-unit-id="msg_old:0"] input')
    old.check()
    expect(page.locator("#preview-values")).to_be_visible()
    expect(page.locator("#selection-summary")).to_contain_text("1 complete tool units · 2 selected parts")
    expect(page.locator("#reported-tokens")).to_have_text("1,000")
    page.locator("#refresh").click()
    expect(old).to_be_checked()
    page.locator("#categories button").filter(has_text="Tool results").click()
    page.locator("#part-search").fill("cart validation")
    expect(page.locator("#selection-summary")).to_contain_text("1 paired parts outside the filter")
    page.locator("#group-mode").select_option("tool")
    expect(page.locator(".group-row")).to_have_count(1)
    expect(page.locator(".group-row .part-size")).to_have_text("≈ 160")
    assert not part_requests, "Grouping must not load full content"
    page.locator(".group-toggle").press("Enter")
    expect(page.locator(".part-row")).to_have_count(2)
    page.locator('.part-row[data-part-id="msg_old:0:result:0"] .part-open').click()
    expect(page.locator("#detail-text")).to_contain_text("cart validation")
    page.locator("#detail-close").click()
    assert len(part_requests) == 1
    page.locator("#clear-filter").click()
    page.locator("#part-search").fill("")
    page.get_by_role("button", name="Select eligible in read", exact=True).click()
    expect(page.locator("#selection-summary")).to_contain_text("2 complete tool units · 4 selected parts")
    expect(page.locator("#selection-notice")).to_contain_text("1 ineligible units skipped")
    expect(page.locator('.part-row[data-part-id="msg_blocked:0:call"] input')).to_be_disabled()
    page.locator("#clear-selection").click()
    expect(page.locator("#preview-values .preview-value").nth(1)).to_contain_text("≈ 0")
    page.locator('.candidate[data-unit-id="msg_old:0"] summary').click()
    expect(page.locator('.candidate[data-unit-id="msg_old:0"] .evidence')).to_have_count(2)
    expect(page.locator('.candidate[data-unit-id="msg_old:0"] details')).to_contain_text("Newest reference")
    print("PASS grouping, filtering, keyboard expansion, blocked units, evidence, whole-call selection, same-revision refresh")

    # Hold an older session's analysis while the user returns to the first session.
    held = []

    def hold_analysis(route):
        payload = route.fetch().json()
        payload["units"][0]["label"] = "STALE ANALYSIS"
        held.append((route, payload))
        page.evaluate("document.body.dataset.fixtureHeld = 'true'")

    page.route("**/ses_other/analysis?*", hold_analysis)
    page.evaluate("document.body.dataset.fixtureHeld = 'false'")
    page.locator("#sessions button").filter(has_text="Review catalog filters").click()
    expect(page.locator("body")).to_have_attribute("data-fixture-held", "true")
    page.locator("#sessions button").filter(has_text="Review checkout validation").click()
    expect(page.locator("#candidate-count")).to_have_text("2")
    held.pop()[0].fulfill(json={"session_id": "ses_other", "revision": "old", "units": [], "groups": [], "findings": []})
    expect(page.locator("#session-id")).to_have_text("[ses_example]")
    expect(page.locator("#candidate-count")).to_have_text("2")
    expect(page.locator("#selection-summary")).to_contain_text("0 complete tool units")
    page.unroute("**/ses_other/analysis?*", hold_analysis)

    def hold_first_preview(route):
        if page.locator("body").get_attribute("data-fixture-held") == "true":
            route.continue_()
            return
        payload = route.fetch().json()
        held.append((route, payload))
        page.evaluate("document.body.dataset.fixtureHeld = 'true'")

    page.route("**/cleanup-preview", hold_first_preview)
    page.evaluate("document.body.dataset.fixtureHeld = 'false'")
    old.check()
    expect(page.locator("body")).to_have_attribute("data-fixture-held", "true")
    old.uncheck()
    expect(page.locator("#preview-values .preview-value").nth(1)).to_contain_text("≈ 0")
    route, payload = held.pop()
    route.fulfill(json=payload)
    expect(page.locator("#preview-values .preview-value").nth(1)).to_contain_text("≈ 0")

    page.evaluate("document.body.dataset.fixtureHeld = 'false'")
    old.check()
    expect(page.locator("body")).to_have_attribute("data-fixture-held", "true")
    source.messages.append(message("user", "msg_later", text="Review another field."))
    page.locator("#refresh").click()
    expect(page.locator("#selection-notice")).to_contain_text("Snapshot changed")
    expect(page.locator("#selection-summary")).to_contain_text("0 complete tool units")
    route, payload = held.pop()
    route.fulfill(json=payload)
    expect(page.locator("#preview-values")).to_be_hidden()
    page.unroute("**/cleanup-preview", hold_first_preview)
    print("PASS late analysis, selection races, and revision changes while previews are pending")

    # A paused browser still sees its old revision after other readers evict it.
    for index in range(8):
        assert httpx.get(f"{base}/api/sessions/ses_evict{index}/context").status_code == 200
    page.locator("#preview-selection").click()
    expect(page.locator("#preview-status")).to_contain_text("Refresh context and reselect")
    expect(page.locator("#preview-values")).to_be_hidden()
    expect(page.locator("#visible-tokens")).not_to_have_text("—")
    page.locator("#refresh").click()
    expect(page.locator("#refresh")).to_be_enabled()

    for status, detail, expected in [
        (422, {"code": "invalid_selection", "message": "Select complete units."}, "Select complete units."),
        (500, {"code": "analysis_unavailable", "message": "Preview unavailable."}, "Preview unavailable."),
        (422, [{"msg": "Invalid selection body"}], "Invalid selection body"),
        (409, "Refresh this snapshot.", "Refresh this snapshot."),
    ]:
        def fail_preview(route, request, status=status, detail=detail):
            route.fulfill(status=status, json={"detail": detail})
        page.route("**/cleanup-preview", fail_preview)
        page.locator("#preview-selection").click()
        expect(page.locator("#preview-status")).to_have_text(expected)
        expect(page.locator("#preview-values")).to_be_hidden()
        page.unroute("**/cleanup-preview", fail_preview)

    def fail_analysis(route):
        route.fulfill(status=500, json={"detail": {"code": "analysis_unavailable", "message": "Try refreshing."}})

    page.route("**/analysis?*", fail_analysis)
    source.messages.append(message("user", "msg_changed", text="Another request."))
    page.locator("#refresh").click()
    expect(page.locator("#analysis-status")).to_have_text("Analysis unavailable. Try refreshing.")
    expect(page.locator("#candidate-count")).to_have_text("—")
    expect(page.locator("#opportunity-total")).to_be_empty()
    expect(page.locator(".part-row").first).to_be_visible()
    page.unroute("**/analysis?*", fail_analysis)

    def older_server(route):
        route.fulfill(status=404, content_type="text/html", body="Not found")

    page.route("**/analysis?*", older_server)
    page.locator("#refresh").click()
    expect(page.locator("#analysis-status")).to_contain_text("Request failed (404)")
    page.unroute("**/analysis?*", older_server)
    page.locator("#refresh").click()
    expect(page.locator("#candidate-count")).to_have_text("2")
    page.locator("#preview-selection").click()
    expect(page.locator("#preview-values")).to_be_visible()
    print("PASS paused eviction, structured/string/validation errors, older servers, and recovery")

    source.messages = demo_messages() + [message("assistant", f"msg_many{index}", content=[
        tool(input={"path": f"src/file{index}.py"})]) for index in range(150)]
    page.locator("#refresh").click()
    expect(page.locator("#refresh")).to_be_enabled()
    page.locator("#group-mode").select_option("flat")
    expect(page.locator(".part-row")).to_have_count(80)
    page.locator("#more-parts").click()
    expect(page.locator(".part-row")).to_have_count(160)
    page.locator("#group-mode").select_option("resource")
    expect(page.locator(".group-row")).to_have_count(80)
    page.locator("#more-parts").click()
    assert page.locator(".group-row").count() > 80
    page.locator("#part-search").fill("no such fixture text")
    expect(page.locator("#parts-empty")).to_be_visible()
    page.locator("#part-search").fill("")
    page.locator("#group-mode").select_option("tool")
    page.locator("#sort").select_option("oldest")
    expect(page.locator(".group-toggle").first).to_contain_text("Non-tool context")
    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Page overflows narrow viewport"
    screenshot = Path('/tmp/opencode/context-cleanup-mobile.png')
    screenshot.parent.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(screenshot), full_page=True)
    assert errors == [], errors
    print("PASS pagination, sorting, empty filters, narrow layout, and no browser runtime errors")


def main():
    chrome = shutil.which("google-chrome") or shutil.which("chromium")
    if not chrome:
        raise RuntimeError("Chrome or Chromium is required for this check")
    source = DemoClient()
    ready = threading.Event()

    class FixtureServer(uvicorn.Server):
        async def startup(self, sockets=None):
            await super().startup(sockets=sockets)
            ready.set()

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        base = f"http://127.0.0.1:{listener.getsockname()[1]}"
        app = create_app(Settings(refresh_seconds=0.1), source, Counter())
        server = FixtureServer(uvicorn.Config(app, log_level="error"))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
        thread.start()
        try:
            if not ready.wait(10):
                raise RuntimeError("Fixture server did not start")
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path=chrome, headless=True, args=["--no-sandbox"])
                page = browser.new_page(viewport={"width": 1440, "height": 1000})
                exercise(page, base, source)
                browser.close()
        finally:
            server.should_exit = True
            thread.join(timeout=10)
    print(json.dumps({"browser_checks": "passed", "source": "fictional fixture only"}))


if __name__ == "__main__":
    main()
