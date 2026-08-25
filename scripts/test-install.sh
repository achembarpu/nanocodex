#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
temporary_root="$(mktemp -d 2>/dev/null)" || {
  echo "test-install: failed to create a temporary directory" >&2
  exit 1
}
trap 'rm -rf -- "$temporary_root"' EXIT

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

mock_bin="$temporary_root/mock-bin"
mkdir -p "$mock_bin"

cat > "$mock_bin/uname" <<'EOF'
#!/bin/sh
case "${1-}" in
  -s) printf '%s\n' Linux ;;
  -m) printf '%s\n' x86_64 ;;
  *) exit 2 ;;
esac
EOF

cat > "$mock_bin/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

head_request=false
output=""
url=""
while (($#)); do
  case "$1" in
    --head)
      head_request=true
      shift
      ;;
    --output)
      output="$2"
      shift 2
      ;;
    --write-out)
      shift 2
      ;;
    http://*|https://*)
      url="$1"
      shift
      ;;
    *)
      shift
      ;;
  esac
done

if [[ "$head_request" == true ]]; then
  printf '%s\n' 'https://github.com/gakonst/nanocodex/releases/tag/v1.2.3'
  exit 0
fi

asset="${url##*/}"
if [[ -z "$output" || ! -f "$NANOCODEX_INSTALL_FIXTURE/$asset" ]]; then
  exit 22
fi
cp "$NANOCODEX_INSTALL_FIXTURE/$asset" "$output"
EOF
chmod +x "$mock_bin/uname" "$mock_bin/curl"

binary_name="nanocodex-x86_64-unknown-linux-gnu"
binary_source="$temporary_root/$binary_name"
printf '%s\n' '#!/bin/sh' 'printf "%s\n" "nanocodex 1.2.3"' > "$binary_source"
chmod +x "$binary_source"

run_case() {
  local format="$1"
  local case_root="$temporary_root/$format"
  local fixture="$case_root/fixture"
  local marker="$case_root/profile-injection"
  local install_root="$case_root/install '\$(touch $marker)'"
  local asset digest output

  mkdir -p "$fixture" "$case_root/home"
  if [[ "$format" == gzip ]]; then
    asset="$binary_name.gz"
    gzip -n -9 -c "$binary_source" > "$fixture/$asset"
  else
    asset="$binary_name"
    cp "$binary_source" "$fixture/$asset"
  fi
  digest="$(sha256_file "$fixture/$asset")"
  printf '%s  %s\n' "$digest" "$asset" > "$fixture/SHA256SUMS"

  output="$(
    PATH="$mock_bin:$PATH" \
      HOME="$case_root/home" \
      SHELL=/bin/bash \
      NANOCODEX_DIR="$install_root" \
      NANOCODEX_INSTALL_FIXTURE="$fixture" \
      bash "$workspace_root/install"
  )"
  grep -Fq 'Installed nanocodex 1.2.3' <<<"$output"
  [[ "$("$install_root/bin/nanocodex" --version)" == 'nanocodex 1.2.3' ]]
  [[ -f "$install_root/updater/nanocodex.sha256" ]]

  PATH=/usr/bin:/bin bash "$case_root/home/.bashrc"
  [[ ! -e "$marker" ]]
}

run_case raw
run_case gzip

echo "installer accepts verified raw and gzip release assets"
