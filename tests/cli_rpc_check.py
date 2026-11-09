"""Qualify installed CLI RPC envelopes against a loopback fixture, not OpenCode."""
import json
import shutil
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    version = ""

    def do_GET(self):
        assert self.path == "/api/info", self.path
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"version": self.version, "pid": 1, "urls": [], "paths": {"tmp": "/tmp/opencode"}}).encode())

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        assert body == {"input": {"session_id": "ses_fixture"}}
        rejected = self.path.startswith("/api/rpc/context-lens/activate")
        payload = {"_tag": "RpcError", "type": "rejected", "message": "Fixture rejected",
                   "data": {"code": "source_changed", "message": "Fixture rejected"}} if rejected else {"output": {"protocol": 1}}
        self.send_response(400 if rejected else 200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(payload).encode())

    def log_message(self, *args):
        pass


def main():
    Handler.version = subprocess.run([shutil.which("opencode"), "--version"], capture_output=True,
                                     text=True, timeout=15, check=True).stdout.strip()
    with ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for method in ("capabilities", "activate"):
                result = subprocess.run([shutil.which("opencode"), "api", "--server", f"http://127.0.0.1:{server.server_port}",
                                         "post", f"/api/rpc/context-lens/{method}", "--data", '{"input":{"session_id":"ses_fixture"}}'],
                                        capture_output=True, text=True, timeout=15, check=False)
                body = json.loads(result.stdout)
                if method == "capabilities":
                    assert result.returncode == 0 and body == {"output": {"protocol": 1}}
                else:
                    assert result.returncode == 1 and body["_tag"] == "RpcError"
                    assert body["data"]["code"] == "source_changed"
            print(f"PASS installed CLI {Handler.version}: output envelope and top-level typed RpcError on loopback fixture")
        finally:
            server.shutdown()
            thread.join(timeout=5)


if __name__ == "__main__":
    main()
