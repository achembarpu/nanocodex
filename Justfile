set dotenv-load := true
set shell := ["bash", "-euo", "pipefail", "-c"]

python_binding_venv := "py/bindings/.venv"
python_binding_bin := python_binding_venv + "/bin/python"
python_binding_maturin := python_binding_venv + "/bin/maturin"
wasm_target := "wasm32-unknown-unknown"

default: run

# Fetch Rust development dependencies.
bootstrap:
    cargo fetch --locked

# Install development tooling for the embedded language bindings.
bootstrap-bindings:
    uv venv "{{python_binding_venv}}"
    uv pip install --python "{{python_binding_bin}}" "maturin>=1.9,<2"
    rustup target add "{{wasm_target}}"
    npm ci --prefix js/bindings
    npm ci --prefix js/artifacts
    npm ci --prefix js/terminal
    npm ci --prefix web/connect-playground
    npm ci --prefix examples/node
    npm ci --prefix examples/react-vite
    npm ci --prefix examples/vercel-workflows

# Compile and install the PyO3 extension into its isolated development environment.
build-python:
    @test -x "{{python_binding_maturin}}" || { echo "run 'just bootstrap-bindings' first" >&2; exit 2; }
    VIRTUAL_ENV="{{justfile_directory()}}/{{python_binding_venv}}" "{{python_binding_maturin}}" develop --manifest-path py/bindings/Cargo.toml

# Run boundary tests. The live follow-on test activates when OPENAI_API_KEY is set.
test-python: build-python
    "{{python_binding_bin}}" -m unittest discover -s py/bindings/tests -v

# Run the persistent Python follow-on example against the live Responses API.
smoke-python: build-python
    "{{python_binding_bin}}" examples/python/follow_on.py

# Run the Python events consumer against the live Responses API.
smoke-python-events: build-python
    "{{python_binding_bin}}" examples/python/events.py

# Run the Python steer/spawn/fork lifecycle example against the live Responses API.
smoke-python-lifecycle: build-python
    "{{python_binding_bin}}" examples/python/lifecycle.py

# Build one Rust/WASM artifact and generate both Node.js and browser bindings.
build-wasm:
    @command -v wasm-bindgen >/dev/null || { echo "install wasm-bindgen-cli matching Cargo.lock" >&2; exit 2; }
    ./scripts/build-js-package.sh

# Exercise the real WASM model loop under Node and the browser host contract.
test-wasm: build-wasm
    npm test --prefix js/bindings
    npm test --prefix js/artifacts
    npm test --prefix js/react
    npm test --prefix js/terminal

# Run custom JavaScript tooling and a follow-on through Node-hosted WASM.
smoke-wasm-node: build-wasm
    npm ci --prefix examples/node
    npm start --prefix examples/node

# Type-check and bundle the React Worker example against the generated web WASM package.
build-react-example: build-wasm
    npm run build --prefix examples/react-vite

# Type-check and bundle the Connect consumer against the reusable terminal package.
build-connect-playground: build-wasm
    npm ci --prefix web/connect-playground
    npm run build --prefix js/terminal
    npm run build --prefix web/connect-playground

# Type-check and test the Rivet Actors WASM consumer.
build-rivet-example: build-wasm
    npm ci --prefix examples/rivet-actors
    npm run check --prefix examples/rivet-actors

# Type-check, test, and bundle the Cloudflare Durable Object WASM consumer.
build-cloudflare-example: build-wasm
    npm ci --prefix services/managed
    npm run check --prefix services/managed

# Type-check, test, and bundle the Vercel Workflow actor consumer.
build-vercel-example: build-wasm
    npm ci --prefix examples/vercel-workflows
    npm run check --prefix examples/vercel-workflows

# Run the React frontend and API Worker together in Cloudflare's Vite environment.
dev-react-example:
    CLOUDFLARE_INCLUDE_PROCESS_ENV=true npm run dev --prefix examples/react-vite -- --host 127.0.0.1

# Exercise background MCP discovery, Code Mode tool_search, and one MCP call.
smoke-mcp:
    cargo run --quiet -p nanocodex-examples --bin mcp

# Build the end-to-end VM tool example. macOS VMM executables need the
# Hypervisor entitlement; signing the built artifact keeps Cargo inputs clean.
build-vm-guest:
    #!/usr/bin/env bash
    set -euo pipefail
    case "$(uname -m)" in
      arm64|aarch64)
        target=aarch64-unknown-linux-musl
        export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER="{{justfile_directory()}}/scripts/aarch64-unknown-linux-musl-linker"
        export CC_aarch64_unknown_linux_musl="{{justfile_directory()}}/scripts/aarch64-unknown-linux-musl-linker"
        export AR_aarch64_unknown_linux_musl="{{justfile_directory()}}/scripts/aarch64-unknown-linux-musl-ar"
        ;;
      x86_64|amd64) target=x86_64-unknown-linux-musl ;;
      *) echo "unsupported VM guest architecture: $(uname -m)" >&2; exit 2 ;;
    esac
    cargo build -p nanocodex-vm --bin nanocodex-vm-guest \
      --no-default-features --features guest-runtime --target "$target"

# Produce the complete prepared-host installation used by VM-backed evals.
# Runtime execution validates this installation but never builds or signs it.
build-eval-host: build-vm-guest
    #!/usr/bin/env bash
    set -euo pipefail
    case "$(uname -m)" in
      arm64|aarch64) target=aarch64-unknown-linux-musl ;;
      x86_64|amd64) target=x86_64-unknown-linux-musl ;;
      *) echo "unsupported eval host architecture: $(uname -m)" >&2; exit 2 ;;
    esac
    cargo build -p nanocodex-bin --bin nanocodex
    install -m 0755 \
      "target/$target/debug/nanocodex-vm-guest" \
      target/debug/nanocodex-vm-guest
    if [ "$(uname -s)" = Darwin ]; then
      codesign \
        --entitlements nanocodex-vm.entitlements \
        --force \
        --sign - \
        target/debug/nanocodex
    fi

# Ask the CLI artifact workflow to build from the exact head of one open PR.
# Nothing is built for ordinary pull_request events.
build-pr-artifacts pr:
    ./scripts/dispatch-pr-artifacts.sh "{{pr}}"

build-vm-example:
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER="{{justfile_directory()}}/scripts/aarch64-unknown-linux-musl-linker" \
    CC_aarch64_unknown_linux_musl="{{justfile_directory()}}/scripts/aarch64-unknown-linux-musl-linker" \
    AR_aarch64_unknown_linux_musl="{{justfile_directory()}}/scripts/aarch64-unknown-linux-musl-ar" \
    cargo build -p nanocodex-examples --bin vm-tools --all-features
    @if [ "$(uname -s)" = "Darwin" ]; then \
        codesign --entitlements nanocodex-vm.entitlements --force --sign - target/debug/vm-tools; \
    fi

# Start the ephemeral localhost Jaeger backend used by the OTLP trace demo.
otel-up:
    @docker compose -f docker-compose.otel.yml up --detach
    @for attempt in {1..50}; do \
        if curl --fail --silent http://127.0.0.1:16686/ >/dev/null; then exit 0; fi; \
        if [ "$attempt" -eq 50 ]; then echo "Jaeger did not become ready within 10 seconds" >&2; exit 1; fi; \
        sleep 0.2; \
    done
    @echo "Jaeger UI: http://127.0.0.1:16686"

# Launch the interactive TUI with OTLP export, loading OPENAI_API_KEY from .env.
run-otel: otel-up
    @test -n "${OPENAI_API_KEY:-}" || { echo "set OPENAI_API_KEY in .env or the environment" >&2; exit 2; }
    @echo "Building and launching the Nanocodex TUI..."
    @cargo run -p nanocodex-bin --bin nanocodex -- \
        --otel-endpoint http://127.0.0.1:4318 \
        --otel-environment local-tui

# Launch the TUI and export per-event/per-frame streaming diagnostics in addition
# to the compact per-turn summaries enabled by `run-otel`.
run-otel-detail: otel-up
    @test -n "${OPENAI_API_KEY:-}" || { echo "set OPENAI_API_KEY in .env or the environment" >&2; exit 2; }
    @echo "Building and launching the Nanocodex TUI with detailed stream timing..."
    @OTEL_LEVEL="warn,nanocodex=info,nanocodex_oai_api=info,nanocodex_tools=info,nanocodex_stream_timing=trace" \
        cargo run -p nanocodex-bin --bin nanocodex -- \
        --otel-endpoint http://127.0.0.1:4318 \
        --otel-environment local-tui

# Focused streaming-performance gate: owned agent lifecycle, event-envelope
# overhead, trace-shaped transcript updates, and steady Ratatui diff rendering.
bench-stream:
    cargo bench -p nanocodex-agent --bench agent_lifecycle
    cargo bench -p nanocodex-oai-api --bench tower_responses -- timed_agent_event_delivery
    cargo bench -p nanocodex-bin --bench tui_render -- tui_stream_telemetry
    cargo bench -p nanocodex-bin --bench tui_render -- tui_transcript_delta
    cargo bench -p nanocodex-bin --bench tui_render -- tui_trace_render
    cargo bench -p nanocodex-bin --bench tui_render -- '^(tui_redraw_scope|tui_streaming_frame_budget)'

# Rebuild every PR #50 hot-path estimate, then enforce the checked-in median
# latency thresholds. TUI frame-count, changed-cell, and output-byte limits are
# asserted inside the representative benchmark workloads themselves.
bench-pr50:
    cargo bench -p nanocodex-agent --bench agent_lifecycle
    cargo bench -p nanocodex-oai-api --bench tower_responses -- '(responses_request_encoding/encoded_raw_value/131072|responses_lite_metadata/code_mode_tool_names_64|pricing_estimation/aggregate_turn_usage|timed_agent_event_delivery/emit_then_try_receive_mirrored_1024)'
    cargo bench -p nanocodex-oai-api --bench fork_history -- '(fork_then_append/immutable_segments/10000|active_boundary_snapshot_then_append/immutable_boundary/10000|incremental_suffix_iteration/last_item/10000|code_mode_history_snapshot/flatten_into_shared_owner/10000|compaction_snapshot/shared_prefix_rewrite/10000|context_accounting_and_compaction/)'
    cargo bench -p nanocodex-oai-api --bench session_lifecycle
    cargo bench -p nanocodex-tools --bench tool_process_output
    cargo bench -p nanocodex-tools --bench mcp_tool_search
    cargo bench -p nanocodex-bin --bench tui_render -- '^(tui_trace_render/codex_long/tail/(80x24|120x40|200x60)|tui_transcript_delta/assistant_100k|tui_stream_telemetry/apply_1024_and_present|tui_branch_state/codex_long/switch_branch|tui_markdown/syntax_fallback_oversized_line_1m|tui_tool_tree/result_269k_cached_frame/120x40|tui_code_mode_stream/apply_16_out_of_order_completions|tui_trace_resize/codex_long/80x24_to_200x60|tui_live_tail_first_frame/assistant_1m_single_line/120x40|tui_smooth_follow/drain_128_row_backlog/120x40|tui_terminal_output/(catch_up_frame|fast_mode_toggle)/120x40|tui_composer_render/multiline_100k/120x40|tui_large_paste/ingest_100k)$'
    ./scripts/check-benchmark-thresholds.sh

# Deterministic warm-image and retained VM protocol latency gates.
bench-vm:
    cargo bench -p nanocodex-vm --bench image_cache
    cargo bench -p nanocodex-vm --bench vm_session -- vm_session_protocol

# Include actual libkrun boot, first RPC, and graceful shutdown. The root disk
# is reflinked before each timed sample and is never mutated directly.
bench-vm-live rootfs runtime firmware=".cache/libkrunfw/libkrunfw":
    just build-vm-example
    NANOCODEX_VM_VMM="{{justfile_directory()}}/target/debug/vm-tools" \
    NANOCODEX_VM_ROOTFS="{{rootfs}}" \
    NANOCODEX_VM_RUNTIME="{{runtime}}" \
    NANOCODEX_VM_FIRMWARE="{{firmware}}" \
    cargo bench -p nanocodex-vm --bench vm_session -- vm_session_live

# Run a tool-using turn and retain events and diagnostic logs independently.
otel-demo:
    @test -n "${OPENAI_API_KEY:-}" || { echo "set OPENAI_API_KEY in .env or the environment" >&2; exit 2; }
    @curl --fail --silent --show-error http://127.0.0.1:16686/ >/dev/null || { echo "run 'just otel-up' first" >&2; exit 2; }
    @mkdir -p .nanocodex/otel-demo
    @rm -f .nanocodex/otel-demo/events.jsonl .nanocodex/otel-demo/tracing.jsonl
    @cargo run --quiet -p nanocodex-bin --bin nanocodex -- \
        run \
        --otel-endpoint http://127.0.0.1:4318 \
        --otel-environment local-demo \
        --log-format json \
        --log-file .nanocodex/otel-demo/tracing.jsonl \
        --thinking=low "Use the available exec tool to run pwd exactly once without modifying anything, then report the path." \
        > .nanocodex/otel-demo/events.jsonl
    @jq --compact-output 'select(.type == "assistant.message" or .type == "tool.started" or .type == "tool.result" or .type == "run.completed") | {type, payload}' .nanocodex/otel-demo/events.jsonl
    @echo "Open http://127.0.0.1:16686 and select service 'nanocodex'."

# Run the deterministic retained-session and hostile-tool observability stress.
otel-stress turns="32" parallel_calls="16":
    @curl --fail --silent --show-error http://127.0.0.1:16686/ >/dev/null || { echo "run 'just otel-up' first" >&2; exit 2; }
    NANOCODEX_STRESS_TURNS="{{turns}}" \
        NANOCODEX_STRESS_PARALLEL_CALLS="{{parallel_calls}}" \
        cargo test --locked --manifest-path bin/nanocodex/Cargo.toml \
        --test it -- \
        --ignored --exact observability_stress::retained_turns_and_hostile_tools_preserve_trace_topology \
        --nocapture --test-threads=1

# Verify that attached child-agent turns share and overlap in their parent trace.
otel-subagent-stress:
    @curl --fail --silent --show-error http://127.0.0.1:16686/ >/dev/null || { echo "run 'just otel-up' first" >&2; exit 2; }
    cargo test --locked --manifest-path bin/nanocodex/Cargo.toml \
        --test it -- \
        --ignored --exact observability_stress::attached_subagents_share_the_parent_trace_and_overlap \
        --nocapture --test-threads=1

# Run the identical workload without installing the OTLP layer for comparison.
otel-stress-baseline turns="32" parallel_calls="16":
    NANOCODEX_STRESS_EXPORT=false \
    NANOCODEX_STRESS_TURNS="{{turns}}" \
        NANOCODEX_STRESS_PARALLEL_CALLS="{{parallel_calls}}" \
        cargo test --locked --manifest-path bin/nanocodex/Cargo.toml \
        --test it -- \
        --ignored --exact observability_stress::retained_turns_and_hostile_tools_preserve_trace_topology \
        --nocapture --test-threads=1

# Stop Jaeger and discard its in-memory trace data.
otel-down:
    @docker compose -f docker-compose.otel.yml down

# Tight inner loop: native model process with local code mode, no Harbor or Docker.
run:
    @cargo run --quiet -p nanocodex-bin --bin nanocodex -- run --thinking=low "Use the available exec tool to run pwd exactly once without modifying anything, then report the path."

# Checks stay small until the end-to-end agent path is real.
check:
    ./scripts/check-crate-boundaries.sh
    ./scripts/check-experimental-boundary.sh
    ./scripts/check-rustls-provider.sh
    cargo fmt --all -- --check
    cargo clippy --workspace --all-targets --all-features --exclude nanocodex-bin -- -D warnings
    cargo clippy --package nanocodex-bin --all-features --bin nanocodex -- -D warnings
    cargo clippy --package nanocodex-bin --all-features --bench tui_render -- -D warnings
    cargo test --workspace

# Validate the versioned artifacts before creating a release tag.
release-check version:
    @workspace_version=$(cargo metadata --no-deps --format-version 1 | jq -er '.packages[] | select(.name == "nanocodex") | .version'); \
        test "{{version}}" = "$workspace_version" || { echo "expected workspace version {{version}}, found $workspace_version" >&2; exit 1; }
    @js_version=$(node -p "require('./js/bindings/package.json').version"); \
        test "{{version}}" = "$js_version" || { echo "expected JavaScript package version {{version}}, found $js_version" >&2; exit 1; }
    @python_version=$(cargo metadata --no-deps --format-version 1 | jq -er '.packages[] | select(.name == "nanocodex-python") | .version'); \
        test "{{version}}" = "$python_version" || { echo "expected Python package version {{version}}, found $python_version" >&2; exit 1; }
    @grep -Fq 'dynamic = ["version"]' py/bindings/pyproject.toml
    @cargo metadata --no-deps --format-version 1 | jq -e --arg version "{{version}}" \
        '[.packages[].dependencies[] | select(.source == null and (.name | startswith("nanocodex"))) | .req] | all(. == ("^" + $version))' >/dev/null
    @grep -Fq "## [{{version}}]" CHANGELOG.md
    @grep -Fq '<!-- generated by git-cliff -->' CHANGELOG.md
    @./scripts/release-crates.sh check
    @for crate_path in $(./scripts/release-crates.sh paths); do \
        grep -Fq "## [{{version}}]" "$crate_path/CHANGELOG.md"; \
        grep -Fq '<!-- generated by git-cliff -->' "$crate_path/CHANGELOG.md"; \
    done
    bash -n install scripts/changelog.sh scripts/check-crate-boundaries.sh scripts/check-docs.sh scripts/check-rustls-provider.sh scripts/publish-crates.sh scripts/release-crates.sh
    ./scripts/check-crate-boundaries.sh
    ./scripts/check-rustls-provider.sh
    @for crate in $(./scripts/release-crates.sh names); do \
        cargo package --locked --allow-dirty --no-verify --config .cargo/release.toml --package "$crate"; \
    done
    ./scripts/check-docs.sh

# Enforce the one-way dependency and publication boundary for experimental crates.
check-experimental:
    ./scripts/check-experimental-boundary.sh

# Regenerate the committed Alloy-style changelog for a release preparation PR.
changelog version:
    @command -v git-cliff >/dev/null || { echo "install git-cliff first: cargo install git-cliff --locked" >&2; exit 2; }
    ./scripts/changelog.sh --tag "v{{version}}"
