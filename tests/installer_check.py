"""Real staged installs into a temporary config; never touches a live OpenCode host."""
import json
import os
import shlex
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run(args, cwd, env, success=True):
    result = subprocess.run(args, cwd=cwd, env=env, text=True, capture_output=True, timeout=300, check=False)
    if (result.returncode == 0) != success:
        raise AssertionError(result.stdout + result.stderr)
    return result.stdout + result.stderr


def check():
    with tempfile.TemporaryDirectory(prefix="lens-install-", dir="/tmp/opencode") as temporary:
        root = Path(temporary)
        home = root / "settings with 'quotes'"
        home.mkdir()
        linked = root / "linked config"
        linked.symlink_to(home, target_is_directory=True)
        config = home / "opencode.jsonc"
        original = '''{
  // Keep the user's automatic compaction policy.
  "compaction": { "auto": true, "buffer": 19000, "keep": { "tokens": 17000 } },
  "model": "fictional/model",
  "plugins": [
    { "package": "unrelated", "options": { "custom": 7 } },
    { "package": SOURCE, "options": {
      // Keep this Lens option comment.
      "custom": "retained", "manualPruning": false,
    } },
    "opencode-context-lens-plugin@0.1.0",
  ],
}
'''.replace("SOURCE", json.dumps(str(ROOT / "plugin")))
        config.write_text(original)
        config.chmod(0o640)
        # A second file must not be edited when the preferred JSONC file exists.
        other = home / "opencode.json"
        other.write_text('{"username":"untouched"}\n')
        env = {**os.environ, "OPENCODE_CONFIG_DIR": str(linked)}
        install = [str(ROOT / "install.sh")]
        run(install, root, env)
        current = home / "context-lens/current"
        first = current.resolve()
        installed = config.read_text()
        assert "Keep the user's automatic compaction policy." in installed
        assert "Keep this Lens option comment." in installed
        assert config.stat().st_mode & 0o777 == 0o640
        assert other.read_text() == '{"username":"untouched"}\n'
        parser = "import {parse} from 'jsonc-parser'; import {readFileSync} from 'node:fs'; console.log(JSON.stringify(parse(readFileSync(process.argv[1],'utf8'))));"
        settings = json.loads(run(["node", "--input-type=module", "-e", parser, str(config)], ROOT / "plugin", env))
        assert settings["compaction"] == {"auto": True, "buffer": 19000, "keep": {"tokens": 17000}}
        assert settings["plugins"] == [{"package": "unrelated", "options": {"custom": 7}},
                                       {"package": str(current), "options": {"custom": "retained", "manualPruning": True}}]
        backups = list(home.glob("opencode.jsonc.lens-backup-*"))
        assert len(backups) == 1 and backups[0].read_text() == original
        assert not (first / "src").exists() and not (first / "dist/test").exists()
        package = json.loads((first / "package.json").read_text())
        assert package["exports"]["./gui-experimental"] == "./dist/gui-experimental.cjs"
        assert (first / "dist/gui-experimental.cjs").is_file()
        assert not (first / "dist/gui.jsx").exists()
        smoke = "const s=(await import('./dist/index.js')).default,t=(await import('./dist/tui.js')).default; if(s.id!=='context-lens'||t.id!=='context-lens.tui') throw Error('exports'); await (await import('./check-gui.mjs')).loadGUI();"
        run(["node", "--input-type=module", "-e", smoke], first, env)
        # Reinstall through a file symlink and from an unrelated directory.
        file_link = root / "selected.jsonc"
        file_link.symlink_to(config)
        run(install + ["--config", str(file_link)], root, env)
        second = current.resolve()
        assert first != second and first.is_dir() and file_link.is_symlink()
        assert config.read_text() == installed
        assert list(home.glob("opencode.jsonc.lens-backup-*")) == backups
        # Fail the build after dependency preparation; config and current release must survive.
        bin_dir = root / "bin"
        bin_dir.mkdir()
        npm = shutil.which("npm")
        assert npm
        (bin_dir / "npm").write_text('#!/bin/sh\nif [ "$1" = run ]; then exit 42; fi\nexec ' + shlex.quote(npm) + ' "$@"\n')
        (bin_dir / "npm").chmod(0o755)
        failure_env = {**env, "PATH": str(bin_dir) + os.pathsep + env["PATH"]}
        assert "build failed" in run(install, root, failure_env, success=False)
        assert current.resolve() == second and config.read_text() == installed
        assert not list((home / "context-lens/releases").glob(".stage-*"))
        run(["node", "--input-type=module", "-e", smoke], second, env)
        # New configuration defaults retain native auto-compaction by omission.
        fresh = root / "fresh/opencode.jsonc"
        run(install + ["--config", str(fresh)], root, env)
        settings = json.loads(fresh.read_text())
        assert "compaction" not in settings and settings["plugins"][0]["options"]["manualPruning"]
        assert fresh.stat().st_mode & 0o777 == 0o600
        print("Installer passed: JSONC preservation, duplicates, symlinks, reinstall, standalone exports, build-failure preservation, fresh config.")


if __name__ == "__main__":
    check()
