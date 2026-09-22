#!/usr/bin/env bash
# =============================================================================
# build.sh — every build in this repository, in one place.
#
# Three build products live here and each has its own toolchain:
#   1. tools/gen*.mjs -> src/combatsimulator/generated/*.js  (code generation)
#   2. webpack        -> dist/                               (legacy UI bundle)
#   3. vite (ui/)     -> ui/dist/                            (React UI)
# plus api/, which has no build step but does own the tests and parity gates.
#
# NOTE ON api/: every api npm script MUST run with api/ as the working
# directory — api/register-loader.js resolves the loader's base URL against
# the cwd, so bare engine imports fail from the repo root.
#
# Usage:  ./build.sh [target ...]
#   (no target)  same as: install gen web ui
#   install      npm ci/install in root, ui/ and api/
#   gen          regenerate src/combatsimulator/generated/*
#   web          webpack bundle -> dist/
#   ui           vite build      -> ui/dist/
#   lint         eslint in ui/
#   test         api unit tests
#   check        api test + sim:check + eval:check (what CI runs)
#   all          everything above
#   clean        remove dist/, ui/dist/
# =============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

say() { printf '\n\033[1;34m==>\033[0m %s\n' "$*"; }

# npm ci when a lockfile is present and honoured, npm install otherwise.
install_deps() {
  local dir="$1"
  say "install: ${dir}"
  if [ -f "${dir}/package-lock.json" ]; then
    (cd "$dir" && npm ci)
  else
    (cd "$dir" && npm install)
  fi
}

t_install() { install_deps .; install_deps ui; install_deps api; }

t_gen() {
  say "generate: src/combatsimulator/generated"
  for g in tools/gen*.mjs; do
    echo "  - $g"
    node "$g"
  done
}

t_web()  { say "webpack -> dist/";     npm run build; }
t_ui()   { say "vite -> ui/dist/";     (cd ui && npm run build); }
t_lint() { say "eslint (ui)";          (cd ui && npm run lint); }
t_test() { say "api tests";            (cd api && npm test); }

t_check() {
  t_test
  say "api sim:check";  (cd api && npm run sim:check)
  say "api eval:check"; (cd api && npm run eval:check)
}

t_clean() { say "clean"; rm -rf dist ui/dist; }

t_all() { t_install; t_gen; t_web; t_ui; t_lint; t_check; }

targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=(install gen web ui)

for t in "${targets[@]}"; do
  case "$t" in
    install|gen|web|ui|lint|test|check|clean|all) "t_${t}" ;;
    *) echo "unknown target: $t" >&2; sed -n '/^# Usage:/,/^# ===/p' "$0" >&2; exit 2 ;;
  esac
done

say "done: ${targets[*]}"
