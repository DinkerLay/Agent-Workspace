#!/usr/bin/env bash
set -euo pipefail

# This is a read-only reference mirror. Updating it never updates product code.
workspace_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
reference_root="${workspace_root}/.references/claudian"
upstream_url="https://github.com/YishenTu/claudian.git"

if [[ ! -d "${reference_root}/.git" ]]; then
  mkdir -p "$(dirname -- "${reference_root}")"
  git clone --depth 1 "${upstream_url}" "${reference_root}"
else
  origin_url="$(git -C "${reference_root}" remote get-url origin)"
  if [[ "${origin_url}" != "${upstream_url}" ]]; then
    echo "Refusing to update an unexpected Claudian mirror origin: ${origin_url}" >&2
    exit 1
  fi
  # CodeGraph is local analysis state, not an upstream working-tree change.
  if [[ -n "$(git -C "${reference_root}" status --porcelain --untracked-files=all -- . ':(exclude).codegraph')" ]]; then
    echo "Refusing to overwrite local Claudian reference changes." >&2
    exit 1
  fi
fi

before_sha="$(git -C "${reference_root}" rev-parse HEAD)"
default_ref="$(git -C "${reference_root}" symbolic-ref --quiet --short refs/remotes/origin/HEAD || true)"
default_branch="${default_ref#origin/}"
default_branch="${default_branch:-main}"

git -C "${reference_root}" fetch --depth 1 origin "${default_branch}"
git -C "${reference_root}" checkout --detach FETCH_HEAD
after_sha="$(git -C "${reference_root}" rev-parse HEAD)"

codegraph sync "${reference_root}"

echo "Claudian reference: ${before_sha} -> ${after_sha}"
git -C "${reference_root}" diff --stat "${before_sha}" "${after_sha}" || true
echo "Next: inspect affected symbols, update the capability audit, then selectively adopt one semantic with a local contract test."
