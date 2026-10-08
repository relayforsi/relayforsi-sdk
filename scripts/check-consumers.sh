#!/usr/bin/env bash
# Type-checks the packed package as a consumer would, for each supported TypeScript version and
# module resolution, with either the DOM lib or @types/node, in strict mode.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cd "$ROOT/packages/sdk"
pnpm pack --pack-destination "$WORK" >/dev/null

cd "$WORK"
echo '{ "name": "consumer", "private": true, "type": "module" }' >package.json
# Install first: npm prunes packages it did not install.
npm install --no-save --silent @types/node@22 "@scure/base@$(node -p "require('$ROOT/packages/sdk/package.json').dependencies['@scure/base']")"
mkdir -p node_modules/relayfor.si
tar -xzf relayfor.si-*.tgz -C node_modules/relayfor.si --strip-components=1
cp "$ROOT/fixtures/consumers/index.ts" index.ts

failed=0
for ts in 5.4.5 5.9.3 7.0.2; do
  for resolution in bundler node16 nodenext; do
    module=$([ "$resolution" = bundler ] && echo esnext || echo "$resolution")
    for env in dom node; do
      if [ "$env" = dom ]; then lib='"es2022", "dom"'; types='[]'; else lib='"es2022"'; types='["node"]'; fi
      cat >tsconfig.json <<EOF
{ "compilerOptions": { "target": "es2022", "lib": [$lib], "module": "$module", "moduleResolution": "$resolution",
  "strict": true, "exactOptionalPropertyTypes": true, "noEmit": true, "skipLibCheck": false, "types": $types },
  "files": ["index.ts"] }
EOF
      if out=$(npx -y -p "typescript@$ts" tsc -p . 2>&1); then
        printf 'ok   TS %-6s %-9s %s\n' "$ts" "$resolution" "$env"
      else
        printf 'FAIL TS %-6s %-9s %s\n%s\n' "$ts" "$resolution" "$env" "$out"
        failed=1
      fi
    done
  done
done
exit "$failed"
