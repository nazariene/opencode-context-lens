"""Review controls against fictional data and a simulated companion plugin."""
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
from analysis_fixtures import Counter, message, tool
from test_summaries import PluginClient

from viewer.server import create_app
from viewer.settings import Settings


def exercise(page, base, source, app):
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    def browser_settings(route):
        settings = route.fetch().json()
        settings["refresh_seconds"] = 0.3
        route.fulfill(json=settings)
    page.route("**/api/settings", browser_settings)
    page.goto(base + "/?session=ses_example")
    expect(page.locator("#view-status")).to_have_text("Live original API context")
    expect(page.locator("#select-all-tools")).to_be_enabled()
    page.locator("#live").click()
    page.locator("#select-all-tools").press("Enter")
    assert not errors, errors
    expect(page.locator("#selection-summary")).to_contain_text("1 complete tool units · 2 selected parts")
    page.locator("#manual-summary").click()
    page.locator(".summary-input").fill("Reviewed fictional summary <script>not executable</script>.")
    page.locator("#save-summary").click()
    expect(page.locator("#draft-status")).to_contain_text("draft · version 1")
    page.locator("#preview-summary").click()
    expect(page.locator("#summary-preview")).to_contain_text("Wrapped summaries")
    expect(page.locator("#activate-summary")).to_be_enabled()
    page.locator(".summary-input").fill("Edited fictional summary.")
    expect(page.locator("#activate-summary")).to_be_disabled()
    page.locator("#save-summary").click()
    expect(page.locator("#draft-status")).to_contain_text("version 2")
    page.locator("#preview-summary").click()
    page.locator("#activate-summary").click()
    expect(page.locator("#replacement-list")).to_contain_text("registered")
    expect(page.locator("#replacement-list")).to_contain_text("No hook application observed")
    page.locator("#replacement-list button").click()
    expect(page.locator("#replacement-list")).to_contain_text("deactivated")
    expect(page.locator("#discard-summary")).to_be_enabled()

    # Browser-independent pins reconcile on control polling while original capture is paused.
    context = httpx.get(base + "/api/sessions/ses_example/context").json()
    pinned = httpx.post(base + "/api/sessions/ses_example/pins", json={"run_id": context["run_id"],
        "revision": context["revision"], "pin_version": 0, "part_ids": ["msg_calls:0:result:0"]})
    assert pinned.status_code == 200
    expect(page.locator("#pin-count")).to_have_text("1")
    expect(page.locator("#selection-summary")).to_contain_text("0 complete tool units")
    expect(page.locator("#summary-editor")).to_be_empty()
    page.reload()
    expect(page.locator("#pin-count")).to_have_text("1")
    page.locator("#live").click()
    page.locator("#pins-panel summary").click()
    page.locator("#pin-list button").filter(has_text="Unpin").click()
    expect(page.locator("#pin-count")).to_have_text("0")

    # Retained history is authoritative for removed content, regardless of newer live snapshots.
    old = httpx.get(base + "/api/sessions/ses_example/history").json()["observations"][-1]["snapshot_id"]
    source.messages.pop()
    page.locator("#refresh").click()
    expect(page.locator("#refresh")).to_be_enabled()
    expect(page.locator("#history-rows")).to_contain_text("Inspect")
    page.get_by_role("button", name=f"Inspect snapshot {old}", exact=True).click()
    expect(page.locator("#view-status")).to_contain_text("Historical snapshot")
    expect(page.locator("#bulk-controls")).to_be_hidden()
    page.locator(".part-row[data-part-id='msg_calls:0:result:0'] .part-open").click()
    expect(page.locator("#detail-text")).to_have_text("Short result")
    page.locator("#detail-close").click()
    source.messages.append(message("user", "msg_next", text="Later conversation"))
    page.locator("#refresh").click()
    expect(page.locator("#view-status")).to_contain_text("Newer live context is available")
    expect(page.locator(".part-row[data-part-id='msg_calls:0:result:0']")).to_be_visible()
    page.locator("#diff-before").select_option(old)
    observations = httpx.get(base + "/api/sessions/ses_example/history").json()["observations"]
    latest = observations[-1]["snapshot_id"]
    page.locator("#diff-after").select_option(latest)
    page.locator("#compare-snapshots").click()
    expect(page.locator("#diff-summary")).to_contain_text("removed")
    page.locator("#diff-class").select_option("removed")
    page.locator("#diff-rows button").filter(has_text="Compare full text").last.click()
    expect(page.locator("#diff-rows pre").first).to_contain_text("Short result")

    # An old pair arriving after return-to-live cannot repopulate the diff panel.
    held = []
    page.route("**/diff?*", lambda route: held.append((route, route.fetch().json())))
    page.locator("#compare-snapshots").click()
    page.wait_for_function("document.querySelector('#diff-status').textContent.includes('Comparing')")
    page.locator("#return-live").click()
    expect(page.locator("#view-status")).to_have_text("Live original API context")
    assert held
    held.pop()[0].fulfill(json={"stale": True})
    expect(page.locator("#diff-panel")).to_be_hidden()
    page.unroute("**/diff?*")

    # Select-all covers unrendered/collapsed units, not only findings; matching includes hidden inputs.
    source.messages = [message("user", "msg_user", text="Fictional bulk source")] + [
        message("assistant", f"msg_bulk{index}", content=[{**tool(outputs=[{"type": "text", "text": f"Fictional result {index}"}]),
                                                         "id": f"call_bulk{index}"}]) for index in range(1000)]
    page.locator("#refresh").click()
    expect(page.locator("#refresh")).to_be_enabled()
    page.locator("#group-mode").select_option("tool")
    page.locator("#select-all-tools").click()
    expect(page.locator("#selection-summary")).to_contain_text("1000 complete tool units · 2000 selected parts")
    page.locator("#select-all-tools").click()
    expect(page.locator("#selection-summary")).to_contain_text("1000 complete tool units")
    page.locator("#clear-selection").click()
    page.locator("#part-search").fill("Fictional result 999")
    page.locator("#select-matching-tools").click()
    expect(page.locator("#selection-summary")).to_contain_text("1 complete tool units · 2 selected parts · 1 paired parts outside the filter")
    expect(page.locator("#bulk-state")).to_contain_text("partial")
    # Delayed generation cannot populate a different selection's editor.
    held_generation = []
    page.route("**/summary-drafts", lambda route: held_generation.append((route, route.fetch().json())))
    page.locator("#generate-summary").click()
    page.wait_for_function("document.querySelector('#draft-status').textContent.includes('generate')")
    page.locator("#clear-selection").click()
    assert held_generation
    route, draft = held_generation.pop()
    route.fulfill(status=202, json=draft)
    expect(page.locator("#summary-editor")).to_be_empty()
    page.unroute("**/summary-drafts")
    source.jobs["job_fixture"]["state"] = "expired"
    # Control polling detects a restart while original capture remains paused.
    previous_run = app.state.history.run_id
    app.state.pins.run_id = "run_restarted_fixture"
    expect(page.locator("#welcome")).to_contain_text("Dashboard restarted")
    expect(page.locator("#dashboard")).to_be_hidden()
    app.state.pins.run_id = previous_run
    page.locator("#refresh").click()
    expect(page.locator("#dashboard")).to_be_visible()
    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Narrow viewport overflow"
    page.screenshot(path="/tmp/opencode/context-review-mobile.png", full_page=True)
    assert errors == [], errors
    print("PASS review/edit/activation, cross-browser pins, history/diff evidence, stale pair/generation, restart, 1000-unit bulk selection, narrow layout")


def main():
    chrome = shutil.which("google-chrome") or shutil.which("chromium")
    if not chrome:
        raise RuntimeError("Chrome or Chromium is required")
    source = PluginClient()
    ready = threading.Event()

    class FixtureServer(uvicorn.Server):
        async def startup(self, sockets=None):
            await super().startup(sockets=sockets)
            ready.set()

    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
        app = create_app(Settings(port=port, refresh_seconds=0), source, Counter())
        server = FixtureServer(uvicorn.Config(app, log_level="error"))
        thread = threading.Thread(target=server.run, kwargs={"sockets": [listener]}, daemon=True)
        thread.start()
        try:
            assert ready.wait(10)
            with sync_playwright() as playwright:
                browser = playwright.chromium.launch(executable_path=chrome, headless=True, args=["--no-sandbox"])
                exercise(browser.new_page(viewport={"width": 1440, "height": 1000}), f"http://127.0.0.1:{port}", source, app)
                browser.close()
        finally:
            server.should_exit = True
            thread.join(timeout=10)
    print(json.dumps({"review_browser_checks": "passed", "source": "fictional fixtures only"}))


if __name__ == "__main__":
    main()
