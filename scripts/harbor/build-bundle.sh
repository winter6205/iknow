#!/usr/bin/env bash
# Build the host-side production bundle that the Harbor iknow adapter uploads
# (IKnowAgent.options.bundle_path / IKNOW_BUNDLE_TGZ).
#
# Stages into a temp dir: the repo's own node_modules keeps its devDependencies,
# which the TS test suite needs, so nothing here runs `npm ci --omit=dev` in
# place. Choose the output with BUNDLE_OUT.
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
out=${BUNDLE_OUT:-/tmp/iknow-bundle.tgz}
stage=$(mktemp -d)
verify=$(mktemp -d)
deps=$(mktemp)
trap 'rm -rf "$stage" "$verify" "$deps"' EXIT

cd "$repo_root"
npm run build

# Production closure only, transitive included: without --all, npm ls prints
# just the top level plus hoisting conflicts, and the bundle then misses
# packages the runtime requires (node-gyp-build under tree-sitter is the one
# that fails the native probe).
npm ls --all --omit=dev --parseable >"$deps"
while read -r dep; do
    [ "$dep" = "$repo_root" ] && continue
    rel=${dep#"$repo_root"/}
    mkdir -p "$stage/$(dirname "$rel")"
    # Rewrite, never merge: a nested dependency may already have arrived inside
    # its parent's subtree, and cp into an existing directory would re-home it.
    rm -rf "$stage/$rel"
    cp -R "$dep" "$stage/$rel"
done <"$deps"

cp package.json "$stage/"
cp -R dist "$stage/dist"
# installRoot is resolved by walking up to the nearest package.json, and the
# search engine looks under <installRoot>/vendor/ripgrep/<version>/<platform>-<arch>/rg.
# A missing rg is a silent downgrade to the Node engine, not a failure.
if [ -d vendor/ripgrep ]; then
    mkdir -p "$stage/vendor"
    cp -R vendor/ripgrep "$stage/vendor/ripgrep"
fi

# A scored run has to be attributable to a commit (ADR-0130 §5 names the state;
# this names the build).
printf '{"gitSha":"%s","dirty":%s,"builtFrom":"%s","arch":"%s-%s"}\n' \
    "$(git rev-parse HEAD)" \
    "$([ -n "$(git status --porcelain)" ] && echo true || echo false)" \
    "$repo_root" "$(uname -s | tr '[:upper:]' '[:lower:]')" "$(uname -m)" >"$stage/BUILDINFO.json"

tar czf "$out" -C "$stage" .

# Mirror the adapter's own smoke probes (_assert_bundle_runtime in
# iknow_harbor/agent.py) so an incomplete closure fails here instead of burning
# a trial container.
tar xzf "$out" -C "$verify"
cd "$verify"
node ./dist/cli.js --version
node -e "import('tree-sitter').then(() => import('tree-sitter-bash')).then(() => console.log('iknow-native-ok'), (error) => { console.error(String(error && error.message)); process.exit(1); })"

echo "bundle: $out ($(du -h "$out" | cut -f1))"
