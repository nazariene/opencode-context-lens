"""Exercise the shipped Desktop GUI in a synthetic shell; no OpenCode server or provider."""
import functools
import http.server
import shutil
import threading
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]


def exercise(page, base):
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.goto(base)
    panel = page.get_by_role("region", name="Context Lens")
    expect(panel).to_be_visible()
    page.evaluate("fixture.menu()")
    page.get_by_role("button", name="Prune tool outputs", exact=True).click()
    report = page.get_by_label("Command report")
    expect(report).to_contain_text("Preview only")
    expect(report).to_contain_text("<script>window.unsafe=true</script>")
    assert page.evaluate("window.unsafe") is None
    request = page.evaluate("fixture.requests.at(-1)")
    assert request["server"] == "Remote Alpha"
    assert request["input"]["text"] == "tools all --outputs"
    assert request["location"]["directory"] == "/fictional/Remote Alpha"
    run = request["input"]["run_id"]
    page.evaluate("fixture.command('apply preview_fixture')")
    expect(report).to_contain_text("Saved policy")
    assert page.evaluate("fixture.requests.at(-1).input.run_id") == run
    page.get_by_label("Lens command").fill("/lens-prune large 100 --apply")
    page.get_by_role("button", name="Run command", exact=True).click()
    expect(report).to_be_visible()
    assert page.evaluate("fixture.requests.at(-1).input.text") == "large 100 --apply"
    page.get_by_text("Conversation range / summary", exact=True).click()
    page.get_by_label("First message ID").fill("msg_first")
    page.get_by_label("Last message ID").fill("msg_last")
    for action in ("range", "summarize brief", "summarize full"):
        page.get_by_label("Range action").select_option(action)
        page.get_by_role("button", name="Preview range", exact=True).click()
        expect(report).to_be_visible()
        assert page.evaluate("fixture.requests.at(-1).input.text") == f"{action} msg_first msg_last"
    page.evaluate("fixture.slow(true)")
    page.get_by_role("button", name="Tool calls", exact=True).click()
    expect(page.get_by_role("status")).to_have_text("Running…")
    expect(page.get_by_role("button", name="Run command", exact=True)).to_be_disabled()
    page.evaluate("fixture.switch('Remote Beta'); fixture.slow(false)")
    expect(page.get_by_label("Lens command")).to_have_value("")
    expect(page.get_by_label("First message ID")).to_have_value("")
    page.get_by_role("button", name="Saved edits", exact=True).click()
    expect(report).to_contain_text("0 active edits")
    page.evaluate("fixture.finish()")
    expect(report).not_to_contain_text("Delayed Alpha")
    page.evaluate("fixture.switch('Remote Alpha')")
    expect(report).to_have_text("Delayed Alpha report")
    page.evaluate("fixture.fail(true)")
    page.get_by_role("button", name="Delete tool calls", exact=True).click()
    expect(page.get_by_role("alert")).to_contain_text("Unsupported provider profile")
    page.evaluate("fixture.fail(false); fixture.slow(true)")
    page.get_by_role("button", name="Help", exact=True).click()
    expect(page.get_by_role("status")).to_be_visible()
    page.evaluate("fixture.close()")
    assert page.evaluate("fixture.pendingAborted()")
    page.evaluate("fixture.finish()")
    assert not errors, errors


def main():
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT / "plugin/dist/desktop-check"))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    chrome = shutil.which("chromium") or shutil.which("google-chrome")
    try:
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(executable_path=chrome, headless=True, args=["--no-sandbox"])
            page = browser.new_page(viewport={"width": 540, "height": 1000})
            exercise(page, f"http://127.0.0.1:{server.server_port}")
            browser.close()
    finally:
        server.shutdown()
        server.server_close()
    print("Desktop GUI passed: shipped bundle, preview/apply, ranges, server routing, stale replies, literal reports, errors and unload.")


if __name__ == "__main__":
    main()
