#!/bin/bash
# The served folder works from a real browser: the app boots from the AppImage, the
# Malleable Document conformance page saves a document from the app's own origin,
# and a LAN-style Host header is refused (documented loopback-only behaviour).
source "$(dirname "$0")/lib.sh"
command -v node >/dev/null || fail "node is required"
PAGE="_mhf-host-test.html"
PACKAGE_DIR="$(cd "$REPO" && node -p "require('node:path').dirname(require.resolve('@panphora/host-conformance/package.json'))")" \
  || fail "the installed conformance package has no page to serve"
[ -f "$PACKAGE_DIR/page/host-test.html" ] || fail "the installed conformance package has no page to serve"
home="$(fresh_home save)"
cp "$PACKAGE_DIR/page/host-test.html" "$home/apps/$PAGE"
port_free_or_fail
launch "$home" --appimage-extract-and-run --no-sandbox > /dev/null
pid="$(cat "$LAB/app.pid")"
wait_for_server 40 || fail "server did not come up"
pass "server up on :$PORT"

code="$(curl -s -o /dev/null -w '%{http_code}' -H "Host: 192.168.1.20:$PORT" "http://127.0.0.1:$PORT/seed.html")"
[ "$code" = "403" ] || fail "LAN Host header got $code, expected 403"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/seed.html")"
[ "$code" = "200" ] || fail "own origin got $code"
pass "Host gate: 403 for a LAN host, 200 for 127.0.0.1"

URL="http://127.0.0.1:$PORT"
URLPATH="/$PAGE"
if [ -f "$REPO/.platform-context.json" ] && [ -f "$REPO/platform-candidate.json" ] && [ -f "$REPO/candidate.json" ]; then
  ( cd "$REPO" && node scripts/conformance-candidate.mjs --platform "${CONFORMANCE_PLATFORM:-}" \
      --url "$URL" --root "$home/apps" --page "$PAGE" --doc "$URLPATH" --target "$URLPATH" ) \
    > "$LAB/conformance.log" 2>&1 \
    || { keep "$LAB/conformance.log"; fail "candidate conformance failed: $(tail -20 "$LAB/conformance.log")"; }
  keep "$LAB/conformance.log"
  pass "conformance evidence recorded against the AppImage's server"
else
  ( cd "$REPO" && node scripts/conformance.mjs \
      --url "$URL" --root "$home/apps" --page "$PAGE" --doc "$URLPATH" --target "$URLPATH" ) \
    > "$LAB/conformance.log" 2>&1 \
    || { keep "$LAB/conformance.log"; fail "conformance run failed: $(tail -20 "$LAB/conformance.log")"; }
  keep "$LAB/conformance.log"
  pass "conformance page passed against the AppImage's server"
fi

stop "$pid"
keep "$LAB/app.log"
ls "$home/.config/Hyperclay Local/" > "$OUT/$CHECK/userdata-listing.txt" 2>/dev/null || true
pass "stopped cleanly"
