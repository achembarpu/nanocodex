#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repository_root"

wasm_target=wasm32-unknown-unknown
target_dir="${CARGO_TARGET_DIR:-$repository_root/target}"
if [[ "$target_dir" != /* ]]; then
  target_dir="$repository_root/$target_dir"
fi

cargo build --locked -p nanocodex-wasm --target "$wasm_target" --profile wasm
wasm_artifact="$target_dir/$wasm_target/wasm/nanocodex_wasm.wasm"
stamp_path="js/bindings/pkg-web/.nanocodex-bindgen-stamp"
fingerprint="$(wasm-bindgen --version; cksum < "$wasm_artifact")"
if [[ -f "$stamp_path" ]] \
  && [[ -f js/bindings/pkg-web/nanocodex_bg.wasm ]] \
  && [[ -f js/bindings/pkg-node/nanocodex_bg.wasm ]] \
  && [[ "$(<"$stamp_path")" == "$fingerprint" ]]; then
  echo "wasm-bindgen outputs are current"
  exit 0
fi

wasm-bindgen "$wasm_artifact" \
  --target nodejs \
  --out-dir js/bindings/pkg-node \
  --out-name nanocodex
wasm-bindgen "$wasm_artifact" \
  --target web \
  --out-dir js/bindings/pkg-web \
  --out-name nanocodex
node js/bindings/scripts/write-package-types.mjs
printf '%s\n' "$fingerprint" > "$stamp_path"
