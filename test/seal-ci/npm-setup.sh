# Run (via bash) by the Travis legs (and test/seal-ci/container-leg.sh) after the
# time-machine registry is configured.
#
# left-pad@0.0.3 is pinned exactly by grunt-jscs > jscs > babel-core@5 >
# line-numbers@0.2.0, but the registry dates it 2016-03-22 (restored after the
# March 2016 unpublish), so the time machine hides it. Add just that version to
# the time machine's cached left-pad document; `npm install
# --cache-min=999999999` then uses the cached copy.
set -euo pipefail
node --version
npm --version
NPM_CACHE="$(npm config get cache)"
npm cache add --registry=https://registry.npmjs.org/ left-pad@0.0.3
npm view left-pad versions
node -e '
var fs = require("fs"), c = process.argv[1],
  live = c + "/registry.npmjs.org/left-pad/.cache.json",
  tm = c + "/time-machines-npm.sealsecurity.io/left-pad/.cache.json",
  l = JSON.parse(fs.readFileSync(live, "utf8")),
  t = JSON.parse(fs.readFileSync(tm, "utf8"));
t.versions["0.0.3"] = l.versions["0.0.3"];
fs.writeFileSync(tm, JSON.stringify(t));
console.log("left-pad versions now: " + Object.keys(t.versions).join(" "));
' "$NPM_CACHE"
