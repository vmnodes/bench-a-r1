#!/usr/bin/env bash
# test/container.sh: builds the real image and checks it starts and answers
# /health, the way the platform will. Needs Docker. Run from the starter folder:
#   bash test/container.sh
set -euo pipefail
cd "$(dirname "$0")/.."
COMMIT="$(git rev-parse HEAD)"
if ! git diff --quiet HEAD -- . || [ -n "$(git ls-files --others --exclude-standard -- .)" ]; then
  echo "WARNING: uncommitted changes here, so $COMMIT does not describe what is being built." >&2
  echo "         Fine for a local test. Commit first for anything you hand over." >&2
fi
TAG="vmnodes-starter:local-test"
docker build -q --build-arg BUILD_COMMIT="$COMMIT" -t "$TAG" . >/dev/null
# The container gets sign-in settings pointing at nothing: we only test health here.
CID="$(docker run -d --rm -p 127.0.0.1::3000 -e VMNODES_PORTAL_URL=http://127.0.0.1:1 -e VMNODES_APP_ID=app_container_test "$TAG")"
trap 'docker stop "$CID" >/dev/null' EXIT
PORT="$(docker port "$CID" 3000/tcp | head -1 | sed 's/.*://')"
for _ in $(seq 1 30); do
  BODY="$(curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null)" && break
  sleep 0.5
done
echo "health: ${BODY:-<no answer>}"
case "${BODY:-}" in
  *"\"buildCommit\":\"$COMMIT\""*) echo "ok   the image reports the commit it was built from" ;;
  *) echo "FAIL health did not report buildCommit $COMMIT"; exit 1 ;;
esac
STATUS="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/api/me")"
[ "$STATUS" = "401" ] && echo "ok   a request with no sign-in is refused (401)" || { echo "FAIL expected 401 without sign-in, got $STATUS"; exit 1; }
echo "container check passed"
