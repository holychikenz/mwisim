#!/usr/bin/env bash
# =============================================================================
# build.sh — every build in this repository, in one place.
#
# Two build products live here and each has its own toolchain:
#   1. tools/gen*.mjs -> src/combatsimulator/generated/*.js  (code generation)
#   2. vite (ui/)     -> ui/dist/                            (React UI)
# plus api/, which has no build step but does own the tests and parity gates.
#
# NOTE ON api/: the api npm scripts run with api/ as the working directory,
# where package.json and their relative paths live. The loader registers
# against its own URL, so a plain `node --import ./api/register-loader.js …`
# works from anywhere.
#
# Usage:  ./build.sh [target ...]
#   (no target)  same as: install gen ui
#   install      npm ci/install in ui/ and api/
#   gen          regenerate src/combatsimulator/generated/*
#   ui           vite build      -> ui/dist/
#   lint         eslint in ui/
#   test         api unit tests
#   check        api test + sim:check + eval:check + twin-quick (what CI runs)
#   all          everything above
#   rust         cargo build + test of the Rust twin (rust/); needs a Rust toolchain
#   wasm         wasm-pack build of the twin -> rust/pkg/ (CSIM_ENGINE=wasm, UI engine toggle)
#   twin         twin:check — the Rust twin against the JS engine, bit for bit
#                (native, plus wasm when rust/pkg/ is built)
#   twin-quick   the fast twin subset in `check`: selftest + check --seeds=2;
#                rebuilds native, and wasm when wasm-pack is on PATH (else native only);
#                SKIPs (and passes) without cargo or a built csim-native
#   clean        remove ui/dist/
# rust, wasm and twin are deliberately NOT in the default or in `all`, so a machine
# without Rust keeps building.
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

t_install() { install_deps ui; install_deps api; }

t_gen() {
  say "generate: src/combatsimulator/generated"
  for g in tools/gen*.mjs; do
    echo "  - $g"
    node "$g"
  done
}

t_ui()   { say "vite -> ui/dist/";     (cd ui && npm run build); }
t_lint() { say "eslint (ui)";          (cd ui && npm run lint); }
t_test() { say "api tests";            (cd api && npm test); }

t_check() {
  t_test
  say "api sim:check";  (cd api && npm run sim:check)
  say "api eval:check"; (cd api && npm run eval:check)
  t_twin_quick
}

t_rust() { say "cargo (rust/)"; (cd rust && cargo build --release --locked && cargo test --release --locked); }
wasm_build() { (cd rust && wasm-pack "$@" build --release --target web --out-dir pkg --out-name csim_twin); }
t_wasm() { say "wasm-pack (rust/ -> rust/pkg/)"; wasm_build; }
t_twin() {
  local engines; engines="$(twin_engines)"
  say "api twin:check (${engines})"
  (cd api && for e in ${engines//,/ }; do npm run twin:check -- selftest --engine="$e"; done && npm run twin:check -- check --engines="$engines")
}

# The engines twin-quick and twin run: native, plus wasm when rust/pkg/ is built.
twin_engines() { if [ -f rust/pkg/csim_twin_bg.wasm ]; then echo native,wasm; else echo native; fi; }

t_twin_quick() {
  if ! command -v cargo >/dev/null || [ ! -x rust/target/release/csim-native ]; then
    say "SKIP twin-quick: no cargo or no rust/target/release/csim-native (run ./build.sh rust)"
    return 0
  fi
  # Never test a stale build: rebuild native (a no-op when fresh), and wasm when wasm-pack can.
  (cd rust && cargo build --release --locked --quiet)
  local engines=native
  if command -v wasm-pack >/dev/null; then
    wasm_build --quiet && engines=native,wasm
  else
    echo "twin-quick: wasm skipped (wasm-pack not on PATH); checking native only"
  fi
  say "twin-quick (${engines})"
  (cd api && for e in ${engines//,/ }; do npm run --silent twin:check -- selftest --engine="$e"; done \
    && npm run --silent twin:check -- check --engines="$engines" --seeds=2 | grep -v '^  MATCH ')
}

t_clean() { say "clean"; rm -rf ui/dist; }

t_all() { t_install; t_gen; t_ui; t_lint; t_check; }

targets=("$@")
[ ${#targets[@]} -eq 0 ] && targets=(install gen ui)

for t in "${targets[@]}"; do
  case "$t" in
    install|gen|ui|lint|test|check|rust|wasm|twin|clean|all) "t_${t}" ;;
    twin-quick) t_twin_quick ;;
    *) echo "unknown target: $t" >&2; sed -n '/^# Usage:/,/^# ===/p' "$0" >&2; exit 2 ;;
  esac
done

say "done: ${targets[*]}"
