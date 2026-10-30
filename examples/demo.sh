#!/usr/bin/env bash
# End-to-end demo with the fake worker: no real agent, no network.
#
#   npm install && npm run build
#   bash examples/demo.sh            # uses a fresh temporary repository
#   bash examples/demo.sh /tmp/x     # or a directory of your choice (must not exist yet)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO="${1:-$(mktemp -d)/demo-repo}"

cos() { node "$ROOT/dist/cli.js" "$@"; }
step() { printf '\n$ %s\n' "$*"; "$@"; }
cosstep() { printf '\n$ cos %s\n' "$*"; cos "$@"; }

mkdir -p "$DEMO" && cd "$DEMO"
git init -q -b main
git config user.name "Demo User" && git config user.email "demo@example.invalid"
git config core.hooksPath /dev/null
echo "# demo service" > README.md
git add -A && git commit -q -m "initial commit"

# Worker = the fake worker from this repository; gate = no TODO may be left in the tree.
cat > cos.config.json <<EOF
{
  "workers": { "default": { "command": "node", "args": ["$ROOT/examples/fake-worker.mjs", "{briefPath}"] } },
  "gates": [ { "name": "no-todo", "command": "! grep -rn TODO --exclude-dir=.git --exclude-dir=.cos ." } ]
}
EOF

cp "$ROOT/examples/plan.yaml" plan.yaml
cosstep plan plan.yaml --id demo
cosstep status
cosstep run start --concurrency 1 || true

cosstep inbox --type question
cosstep inbox --type escalation
cosstep task show --task ui

cosstep answer --message m5 --text token
cosstep retry --task ui
cosstep gate list
cosstep gate resolve --gate g1 --decision /docs
cosstep run start --concurrency 1

cosstep status
step git log --oneline --graph cos/demo/integration
step git show cos/demo/integration:fake-output/api.txt
step git show cos/demo/integration:fake-output/docs.txt
step git branch --show-current
step git status --short
cosstep cleanup
