#!/usr/bin/env bash
#
# release.sh — Tag a new engawa version and wait for the GHCR image build.
#
# Usage:
#   scripts/release.sh                   # Diagnose: unreleased commits, CI, next-version candidates
#   scripts/release.sh vX.Y.Z            # Release: guards -> annotated tag -> push -> wait for GHCR build
#   scripts/release.sh vX.Y.Z "subject"  # Same, with an explicit tag subject
#
# Versioning: new feature -> minor (vX.Y+1.0); bug fix -> patch (vX.Y.Z+1).
# This repo is host-agnostic OSS: releasing means publishing the image to GHCR.
# Deploying that image to a specific host lives in a separate, host-specific repo.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

BRANCH="main"
RELEASE_WORKFLOW="release.yml"
CI_WORKFLOW="ci.yml"

die() { echo "ERROR: $*" >&2; exit 1; }
command -v gh >/dev/null || die "gh (GitHub CLI) is required"

echo "==> Fetching refs and tags"
git fetch origin --tags --quiet

LATEST_TAG="$(git tag --sort=-v:refname | head -1)"

# ---- Diagnose mode (no args) ----
if [ $# -eq 0 ]; then
  echo "Latest tag : ${LATEST_TAG:-(none)}"
  echo
  echo "Unreleased commits (${LATEST_TAG:-start}..origin/${BRANCH}):"
  if [ -n "$LATEST_TAG" ]; then
    git log --oneline "${LATEST_TAG}..origin/${BRANCH}"
  else
    git log --oneline -10 "origin/${BRANCH}"
  fi
  echo
  echo -n "main CI    : "
  gh run list --workflow "$CI_WORKFLOW" --branch "$BRANCH" --limit 1 \
    --json conclusion,status,headSha --jq '.[0] | "\(.conclusion // .status) (\(.headSha[0:7]))"'
  echo
  if [[ "$LATEST_TAG" =~ ^v([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
    MA="${BASH_REMATCH[1]}"; MI="${BASH_REMATCH[2]}"; PA="${BASH_REMATCH[3]}"
    echo "Next version candidates:"
    echo "  patch (bug fix)     : v${MA}.${MI}.$((PA + 1))"
    echo "  minor (new feature) : v${MA}.$((MI + 1)).0"
  fi
  echo
  echo 'To release: scripts/release.sh vX.Y.Z "subject"'
  exit 0
fi

# ---- Release mode ----
TAG="$1"
SUBJECT="${2:-}"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "Version must look like vX.Y.Z (got: $TAG)"

# Guards
[ -z "$(git status --porcelain)" ] || die "Working tree is not clean"
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null && die "Tag $TAG already exists"
LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse "origin/${BRANCH}")"
[ "$LOCAL_HEAD" = "$REMOTE_HEAD" ] || die "HEAD is not at origin/${BRANCH}; a release tag must point at released main"

echo "==> Checking main CI is green"
CI_CONCLUSION="$(gh run list --workflow "$CI_WORKFLOW" --branch "$BRANCH" --limit 1 \
  --json conclusion,headSha --jq ".[0] | select(.headSha==\"$REMOTE_HEAD\") | .conclusion")"
[ "$CI_CONCLUSION" = "success" ] || die "main CI for ${REMOTE_HEAD:0:7} is not green (got: ${CI_CONCLUSION:-none})"

[ -n "$SUBJECT" ] || SUBJECT="$(git log -1 --pretty=%s)"

echo "==> Creating annotated tag $TAG"
git tag -a "$TAG" -m "${TAG}: ${SUBJECT}"
echo "==> Pushing $TAG (triggers ${RELEASE_WORKFLOW})"
git push origin "$TAG"

echo "==> Waiting for the release workflow to start"
RUN_ID=""
for _ in $(seq 1 20); do
  RUN_ID="$(gh run list --workflow "$RELEASE_WORKFLOW" --limit 5 \
    --json databaseId,headBranch --jq "[.[] | select(.headBranch==\"$TAG\")][0].databaseId")"
  [ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ] && break
  sleep 3
done
[ -n "$RUN_ID" ] && [ "$RUN_ID" != "null" ] || die "Could not find the release run for $TAG"

echo "==> Watching GHCR build (run $RUN_ID)"
gh run watch "$RUN_ID" --exit-status --interval 15 || die "GHCR build failed (run $RUN_ID)"

echo
echo "OK: ghcr.io/iitenkida7/engawa:${TAG} published to GHCR."
