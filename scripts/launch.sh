#!/usr/bin/env bash
# One-shot launch: creates the public GitHub repo, pushes main, turns on GitHub
# Pages, and publishes trace-viz to npm.
#
#   ./scripts/launch.sh <github-user-or-org>
#
# Needs: gh (`gh auth login`) and npm (`npm login`), both already logged in.
set -euo pipefail
GH=${1:?github user or org}

node - "$GH" <<'JS'
const fs = require('fs');
const [gh] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync('package.json', 'utf8'));
p.repository = { type: 'git', url: `git+https://github.com/${gh}/trace-viz.git` };
p.homepage = `https://${gh}.github.io/trace-viz/`;
p.bugs = { url: `https://github.com/${gh}/trace-viz/issues` };
fs.writeFileSync('package.json', JSON.stringify(p, null, 2) + '\n');
let r = fs.readFileSync('README.md', 'utf8').replace(/https:\/\/[a-z0-9-]+\.github\.io\/trace-viz\//g, `https://${gh}.github.io/trace-viz/`);
fs.writeFileSync('README.md', r);
JS
git add -A && git commit -q -m "Point at ${GH}/trace-viz" || true

npm ci
npm run typecheck
npm test
npm run build

git branch -M main
gh repo create "${GH}/trace-viz" --public --source=. --remote=origin --push \
  --description "Visualize service topologies as living, re-projectable pictures. Every dimension is a knob."
gh api -X POST "repos/${GH}/trace-viz/pages" -f build_type=workflow >/dev/null 2>&1 || true

npm publish --access public

echo
echo "repo:  https://github.com/${GH}/trace-viz"
echo "demo:  https://${GH}.github.io/trace-viz/   (after the pages workflow finishes)"
echo "npm:   https://www.npmjs.com/package/trace-viz"
