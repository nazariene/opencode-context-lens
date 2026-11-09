"""Manual pruning UX against fictional plugin responses only."""
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
from analysis_fixtures import Counter
from test_pruning import PruningClient

from viewer.server import create_app
from viewer.settings import Settings


def exercise(page, base, source):
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base + "/?session=ses_example")
    expect(page.locator("#pruning-all")).to_be_enabled()
    expect(page.locator("#pruning-items input")).to_have_count(60)
    page.locator("#pruning-all").click()
    expect(page.locator("#pruning-selection")).to_contain_text("72 selected")
    page.locator("#pruning-clear").click()
    page.locator("#pruning-search").fill("result 71")
    page.locator("#pruning-matching").click()
    expect(page.locator("#pruning-selection")).to_contain_text("1 selected")
    page.locator("#pruning-preview").click()
    expect(page.locator("#pruning-apply")).to_be_enabled()
    expect(page.locator("#pruning-review")).to_contain_text("Fictional result 71")
    assert not source.edits
    page.locator("#pruning-apply").click()
    expect(page.locator("#pruning-status")).to_contain_text("1 saved edits")
    expect(page.locator("#pruning-items")).to_contain_text("[Output pruned]")
    page.reload()
    expect(page.locator("#pruning-status")).to_contain_text("1 saved edits")
    page.locator("#pruning-panel > details > summary").click()
    page.locator("#pruning-edits button").click()
    expect(page.locator("#pruning-status")).to_contain_text("0 saved edits")
    page.locator("#pruning-action").select_option("remove-reasoning")
    page.locator("#pruning-all").click()
    page.locator("#pruning-preview").click()
    expect(page.locator("#pruning-review")).to_contain_text("<script>window.unsafe=true</script>")
    assert page.evaluate("window.unsafe") is None
    page.locator("#pruning-action").select_option("delete-invocation")
    expect(page.locator("#pruning-apply")).to_be_disabled()
    page.locator("#pruning-search").fill("")
    page.locator("#pruning-large").click()
    expect(page.locator("#pruning-selection")).to_contain_text("1 selected")
    page.locator("#pruning-preview").click()
    expect(page.locator("#pruning-review")).to_contain_text("Fictional result 71")
    for action in ("delete-range", "summarize-brief", "summarize-full"):
        page.locator("#pruning-action").select_option(action)
        expect(page.locator("#pruning-range")).to_be_visible()
        page.locator("#pruning-first").select_option("range_msg_user")
        page.locator("#pruning-last").select_option("range_msg_calls")
        page.locator("#pruning-preview").click()
        expect(page.locator("#pruning-apply")).to_be_enabled()
        expect(page.locator("#pruning-review")).to_contain_text("Fictional assistant range source")
        if action.startswith("summarize-"):
            expect(page.locator("#pruning-review")).to_contain_text("Fictional range summary")
            assert page.evaluate("window.unsafe") is None
    page.locator("#pruning-apply").click()
    expect(page.locator("#pruning-status")).to_contain_text("2 saved edits")
    page.locator("#pruning-edits button").click()
    expect(page.locator("#pruning-status")).to_contain_text("0 saved edits")
    page.locator("#pruning-action").select_option("delete-invocation")
    # A completed native checkpoint invalidates an in-progress review and reports the new cycle.
    page.locator("#pruning-search").fill("result 2")
    page.locator("#pruning-matching").click()
    page.locator("#pruning-preview").click()
    expect(page.locator("#pruning-apply")).to_be_enabled()
    source.revision += 1
    source.last_compaction = {"id": "msg_checkpoint", "at": 1}
    page.locator("#refresh").click()
    expect(page.locator("#pruning-status")).to_contain_text("reset after native compaction")
    expect(page.locator("#pruning-apply")).to_be_disabled()
    page.locator("#pruning-search").fill("")
    context = httpx.get(base + "/api/sessions/ses_example/context").json()
    pinned = httpx.post(base + "/api/sessions/ses_example/pins", json={"run_id": context["run_id"],
        "revision": context["revision"], "pin_version": 0, "part_ids": ["msg_calls:0:result:0"]})
    pinned.raise_for_status()
    page.locator("#refresh").click()
    expect(page.locator("#pruning-selection")).to_contain_text("1 pinned")
    page.locator("#pruning-all").click()
    expect(page.locator("#pruning-selection")).to_contain_text("71 selected")
    page.get_by_role("button", name="Inspect snapshot", exact=False).first.click()
    expect(page.locator("#pruning-panel")).to_be_hidden()
    page.locator("#return-live").click()
    expect(page.locator("#pruning-panel")).to_be_visible()
    expect(page.locator("#pruning-apply")).to_be_disabled()
    # A late preview must not populate another selection or session.
    page.locator("#pruning-search").fill("result 1")
    page.locator("#pruning-matching").click()
    pending = []
    page.route("**/pruning/preview", lambda route: pending.append(route))
    page.locator("#pruning-preview").click()
    expect(page.locator("#pruning-message")).to_contain_text("Building exact")
    page.locator("#sessions button").filter(has_text="Review catalog filters").click()
    expect(page.locator("#pruning-status")).to_contain_text("0 saved edits")
    assert pending
    pending.pop().fulfill(json={"preview_id": "late", "rows": [], "expanded_count": 0, "expires_at": 9999999999999,
                                "estimated_savings": 0, "measurement": "late"})
    expect(page.locator("#pruning-review")).to_be_empty()
    expect(page.locator("#pruning-apply")).to_be_disabled()
    assert not errors, errors


def main():
    source = PruningClient(72)
    chrome = shutil.which("chromium") or shutil.which("chromium-browser") or shutil.which("google-chrome")
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
                exercise(browser.new_page(viewport={"width": 1440, "height": 1000}), f"http://127.0.0.1:{port}", source)
                browser.close()
        finally:
            server.should_exit = True
            thread.join(timeout=10)
    print(json.dumps({"pruning_browser_checks": "passed", "source": "fictional fixtures only"}))


if __name__ == "__main__":
    main()
