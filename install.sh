#!/usr/bin/env bash
set -euo pipefail

project=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
config_dir=${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}
config=
while (($#)); do
  case "$1" in
    --config)
      (($# >= 2)) || { echo 'install.sh: --config requires a file path' >&2; exit 1; }
      config=$2; shift 2 ;;
    -h|--help)
      cat <<'HELP'
Usage: ./install.sh [--config FILE]

Build and install Context Lens (server, terminal and Desktop extensions).
Default config: OPENCODE_CONFIG_DIR or XDG_CONFIG_HOME/opencode/opencode.json(c).
Enables manual pruning; preserves compaction settings and other plugins/options.
Requires npm. Downloads Node 26.4 if the current Node is older.
Run /lens-prune help in Terminal or Desktop; no service restart is performed.
HELP
      exit 0 ;;
    *) printf 'install.sh: unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done
if [[ -z "$config" ]]; then
  if [[ -f "$config_dir/opencode.jsonc" ]]; then config="$config_dir/opencode.jsonc"
  elif [[ -f "$config_dir/opencode.json" ]]; then config="$config_dir/opencode.json"
  else config="$config_dir/opencode.jsonc"; fi
fi
command -v npm >/dev/null || { echo 'install.sh: npm is required' >&2; exit 1; }
if ! node -e 'const [major,minor]=process.versions.node.split(".").map(Number); process.exit(major>26 || major===26 && minor>=4 ? 0 : 1)' 2>/dev/null; then
  exec npx --yes --package=node@26.4.0 -- bash "$project/install.sh" --config "$config"
fi
exec node "$project/plugin/install.mjs" "$config"
