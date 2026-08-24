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
binaryen="$repository_root/js/bindings/node_modules/.bin/wasm-opt"
if [[ ! -x "$binaryen" ]]; then
  echo "missing Binaryen; run npm ci in js/bindings" >&2
  exit 1
fi
stamp_path="js/bindings/pkg-web/.nanocodex-bindgen-stamp"
fingerprint="$(wasm-bindgen --version; "$binaryen" --version; printf 'worker-bundler-v1-simd\n'; cksum < "$wasm_artifact")"
if [[ -f "$stamp_path" ]] \
  && [[ -f js/bindings/pkg-web/nanocodex_bg.wasm ]] \
  && [[ -f js/bindings/pkg-web/nanocodex_bg.js ]] \
  && [[ -f js/bindings/pkg-web/nanocodex_worker.js ]] \
  && [[ -f js/bindings/pkg-node/nanocodex.js ]] \
  && [[ "$(<"$stamp_path")" == "$fingerprint" ]] \
  && node js/bindings/scripts/write-wasm-attestation.mjs --check-cache "$wasm_artifact" 2>/dev/null; then
  node js/bindings/scripts/write-wasm-attestation.mjs "$wasm_artifact"
  echo "wasm-bindgen outputs are current"
  exit 0
fi

generated_dir="$(mktemp -d)"
trap 'rm -rf "$generated_dir"' EXIT
worker_bindings="$generated_dir/worker"
mkdir "$worker_bindings"
wasm-bindgen "$wasm_artifact" \
  --target nodejs \
  --out-dir js/bindings/pkg-node \
  --out-name nanocodex
wasm-bindgen "$wasm_artifact" \
  --target web \
  --out-dir js/bindings/pkg-web \
  --out-name nanocodex
wasm-bindgen "$wasm_artifact" \
  --target bundler \
  --out-dir "$worker_bindings" \
  --out-name nanocodex
cmp "$worker_bindings/nanocodex_bg.wasm" js/bindings/pkg-web/nanocodex_bg.wasm
cp "$worker_bindings/nanocodex_bg.js" js/bindings/pkg-web/nanocodex_bg.js
cp "$worker_bindings/nanocodex.js" js/bindings/pkg-web/nanocodex_worker.js
generated_wasm="js/bindings/pkg-web/nanocodex_bg.wasm"
optimized_wasm="$generated_dir/nanocodex.wasm"
"$binaryen" -Oz \
  --enable-bulk-memory \
  --enable-bulk-memory-opt \
  --enable-nontrapping-float-to-int \
  --enable-simd \
  --strip-debug \
  --strip-producers \
  --strip-toolchain-annotations \
  "$generated_wasm" \
  -o "$optimized_wasm"
mv "$optimized_wasm" "$generated_wasm"
node js/bindings/scripts/deduplicate-wasm.mjs
node js/bindings/scripts/write-package-types.mjs
printf '%s\n' "$fingerprint" > "$stamp_path"
node js/bindings/scripts/write-wasm-attestation.mjs "$wasm_artifact"
