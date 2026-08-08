# nanocodex-eval

`nanocodex-eval` owns Nanocodex's VM-isolated execution boundary and durable
profile ledger. A profile defines the complete desired task and treatment
matrix. Callers choose an exact family; SQLite allocates one internal
repetition and fences its accepted completion.

The ledger deliberately has no `next work`, `run all`, concurrency, or host
saturation policy. An embedding application or the `/benchmark` agent decides
which family to run and how many one-coordinate processes to launch.

Every benchmark attempt runs tools and verification in a microVM. Native host
execution exists only inside focused crate tests. Harbor JSONL and ATIF are
output formats, not alternate runners.

## Durable API

```rust,no_run
use std::time::Duration;
use nanocodex_eval::{Evaluation, EvaluationClaim, EvaluationSelector};

# async fn example() -> Result<(), Box<dyn std::error::Error>> {
let evaluation = Evaluation::open(
    "nanocodex.toml",
    Some("local-smoke"),
    ".nanocodex/evals",
)?;
let selector = EvaluationSelector::new("tasks/write-greeting");
match evaluation.claim(&selector, Duration::from_secs(300))? {
    EvaluationClaim::Prepare(claim) => {
        // Prepare `claim.task()`, then atomically accept or retry the lease.
        claim.complete()?;
    }
    EvaluationClaim::Run(claim) => {
        // Execute `claim.task()` with `claim.treatment()` and retain output in
        // `claim.output_directory()`, then accept or retry the result.
        let evidence = claim.output_directory().to_path_buf();
        claim.complete(&evidence)?;
    }
    EvaluationClaim::Busy(_) | EvaluationClaim::Complete => {}
}
# Ok(())
# }
```

Claims own lease heartbeats and fenced completion. Raw SQLite worksets, lease
generations, and artifact-coordinate construction are private implementation
details.

## Profiles

The repository manifest is `nanocodex.toml`:

```toml
default = "local-smoke"

[profiles.local-smoke]
tasks = ["tasks/write-greeting"]
trials = 3
model = ["sol"]
thinking = ["low"]
```

`Evaluation::open` resolves task packages, fingerprints their complete
execution inputs, and materializes every desired repetition in SQLite before
execution begins. Profiles selecting an external harness also fingerprint its
semantic configuration and pinned executable release.

```text
profile -> exact task/treatment families -> k=1..N SQLite coordinates
                                      \
                                       -> callers choose families and fan-out
```

Task preparation is durable state too. One process owns a fenced preparation
lease while competing processes receive a temporary-unavailable result. A
coordinate completion is accepted only while its lease generation is current;
an expired worker cannot overwrite its replacement.

Leases guarantee exactly-once accepted completion, not absolutely
exactly-once model spending after a worker becomes unreachable. Heartbeats and
conservative expiry reduce duplicate spending; generation fencing prevents a
stale result from being committed.

## External harnesses

An omitted harness means the built-in Nanocodex library runner. External
harnesses are ordinary independent coordinates:

```toml
[harness.codex]
command = "harness/codex"
guest_command = "/usr/local/bin/codex"
version = "0.145.0"
arguments = [
  "exec", "--json", "--ephemeral",
  "--dangerously-bypass-approvals-and-sandbox",
  "--skip-git-repo-check",
  "--model", "{model}",
  "--config", "model_reasoning_effort=\"{thinking}\"",
  "--config", "openai_base_url=\"{api_base_url}\"",
  "--", "{prompt}",
]
environment = { CODEX_HOME = "/run/nanocodex-harness-home" }
# Optional defaults shown explicitly; other CLIs can choose their own paths.
home = "/run/nanocodex-harness-home"
auth_file = "/run/nanocodex-harness-home/auth.json"
api_key_environment = "OPENAI_API_KEY"

[profiles.compare]
tasks = ["tasks/write-greeting"]
trials = 5
harness = ["nanocodex", "codex"]
model = ["sol", "luna"]
thinking = ["medium", "high"]
```

Durable task preparation installs the configured command at `guest_command`
inside the immutable task image. Every coordinate receives a fresh writable
overlay and routes the harness's OpenAI-compatible traffic through the same
capture proxy. The command path,
`arguments`, `environment`, credential paths, API-key environment name, and
`api_upstream` are profile data; argument
templates support `{prompt}`, `{model}`, `{thinking}`, `{web_search}`, and
`{api_base_url}`. Environment values additionally support `{api_base_url}`,
`{harness_home}`, and `{auth_file}`. Authentication is exposed at the neutral
`NANOCODEX_HARNESS_AUTH_FILE` and `NANOCODEX_HARNESS_HOME` paths, so an
agent-specific home variable such as `CODEX_HOME` is only configuration.

An external binary must emit the harness JSONL contract on stdout. The current
contract is the small event vocabulary emitted by `codex exec --json`
(`thread.started`, item events, and one terminal turn event), so Codex works
directly and another CLI can use a thin output wrapper. Rust contains no Codex
binary path, command line, or execution mode.

There is no matched-pair runner or comparison state machine. Each harness emits
its own result JSON, raw JSONL, trajectory, verifier evidence, and ledger row.
Differential reports are ordinary offline queries joining matching coordinate
dimensions.

Prepared task images and memory observations remain content-addressed cache
inputs. Each arm still receives a fresh writable overlay, so filesystem and
process state cannot leak between profile repetitions.

## CLI

```sh
# Materialize the complete closed profile and inspect exact counts.
nanocodex eval status local-smoke --json

# Execute one SQLite-assigned repetition from an exact profile task.
nanocodex eval run local-smoke --task tasks/write-greeting

# Execute the matching configured external-harness coordinate.
nanocodex eval run compare --task tasks/write-greeting --harness codex \
  --model luna --thinking high

# Coordinate workers through one SQLite owner. Remote hosts reach this
# loopback listener through an SSH reverse tunnel and run the same command.
nanocodex eval coordinator compare --port 8789
nanocodex eval run compare --coordinator http://127.0.0.1:8789 \
  --task tasks/write-greeting --harness codex --model luna --thinking high

# Install the coordinator as a durable user service. Its end-to-end HTTP
# watchdog restarts the process if the listener stops answering requests.
nanocodex eval coordinator compare --port 8789 --systemd

# Let an agent inspect the ledger and choose task order and process fan-out.
nanocodex eval benchmark local-smoke
# Equivalent interactive workflow:
nanocodex
# then enter: /benchmark local-smoke
```

`--state-dir` overrides the default `~/.nanocodex/evals`. There is no trial
argument: `trials` is profile-owned desired work, and SQLite assigns a
fungible repetition inside the exact family selected by `--task` and any
needed harness, model, or thinking selectors.

Remote workers send only retained evaluation evidence: JSON/JSONL trajectories,
events, API exchanges and summaries, plus verifier reward/stdout/stderr. VM
disks, workspaces, task fixtures, caches, and runtime logs remain host-local and
failed writable roots are disposable. Evidence is streamed as a zstd-compressed
tar, validated against the same allowlist by the coordinator, extracted into a
staging directory, and atomically renamed before fenced SQLite completion.

VM-backed evals consume a prepared host installation. The matching static
`nanocodex-vm-guest` must be installed beside the `nanocodex` executable; VM
state is cached under `~/.cache/nanocodex/vm` (or
`$NANOCODEX_HOME/cache/vm`). Runtime execution never builds, signs, discovers,
or repairs that substrate. Source checkouts can produce the complete local
installation with `just build-eval-host`; an incomplete installation fails
before task preparation.
