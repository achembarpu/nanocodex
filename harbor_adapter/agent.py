"""Install and run Nanocodex inside a Harbor task environment."""

from __future__ import annotations

import asyncio
import json
import re
import shlex
import tempfile
import time
from pathlib import Path
from typing import Any

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trajectories import (
    Agent,
    FinalMetrics,
    Metrics,
    Observation,
    ObservationResult,
    Step,
    ToolCall,
    Trajectory,
)
from harbor.utils.trajectory_utils import format_trajectory_json


PROTOCOL_VERSION = 1
MODEL = "gpt-5.6-sol"
TERMINAL_EVENTS = {"run.completed", "run.failed"}
RUN_METRIC_FIELDS = (
    "connection_attempts",
    "websocket_reconnects",
    "connection_duration_ns",
    "model_duration_ns",
    "warmup_duration_ns",
    "tool_work_duration_ns",
    "tool_wall_duration_ns",
)
USAGE_METRIC_FIELDS = ("cache_write_input_tokens", "reasoning_output_tokens")


def _cli_tools_install_command(*, install_node: bool) -> str:
    """Build a portable installer for the stock Codex task-side CLI toolset."""
    packages = ["ca-certificates", "curl", "bash", "ripgrep"]
    checks = ["curl", "bash", "rg"]
    node_modules_cleanup = ""
    if install_node:
        packages.extend(("nodejs", "npm"))
        checks.extend(("node", "npm"))
        # FastDockerEnvironment exposes missing system Node modules through
        # read-only symlinks into its shared toolbox. Remove only those links
        # before the task package manager installs its writable Node tree.
        node_modules_cleanup = (
            "if [ -L /usr/share/nodejs ] && "
            '[ "$(readlink /usr/share/nodejs)" = '
            '"/opt/nanocodex-toolbox/usr/share/nodejs" ]; then '
            "rm /usr/share/nodejs && mkdir -p /usr/share/nodejs; "
            "elif [ -d /usr/share/nodejs ]; then "
            "for node_module_entry in /usr/share/nodejs/*; do "
            '[ -L "$node_module_entry" ] || continue; '
            'case "$(readlink "$node_module_entry")" in '
            "/opt/nanocodex-toolbox/usr/share/nodejs/*) "
            'rm "$node_module_entry" ;; '
            "esac; done; fi; "
        )

    package_list = " ".join(packages)
    command_checks = "; ".join(
        f"command -v {command} >/dev/null 2>&1" for command in checks
    )
    return (
        node_modules_cleanup
        + "if ldd --version 2>&1 | grep -qi musl || "
        "[ -f /etc/alpine-release ]; then "
        f"apk add --no-cache {package_list}; "
        "elif command -v apt-get >/dev/null 2>&1; then "
        "apt-get update && DEBIAN_FRONTEND=noninteractive "
        "apt-get install --yes --no-install-recommends "
        f"{package_list}; "
        "elif command -v yum >/dev/null 2>&1; then "
        f"yum install -y {package_list}; "
        "else "
        "echo 'No supported package manager found; checking preinstalled tools' >&2; "
        "fi; "
        f"{command_checks}"
    )


def _remote_binary_install_command(
    *, binary_url: str, binary_sha256: str, destination: str
) -> str:
    """Download one immutable binary inside the Harbor environment."""
    return (
        "temporary=$(mktemp); "
        'trap \'rm -f "$temporary"\' EXIT; '
        "curl --fail --location --retry 5 --retry-all-errors "
        f'--output "$temporary" {shlex.quote(binary_url)}; '
        "if command -v sha256sum >/dev/null 2>&1; then "
        'actual=$(sha256sum "$temporary" | awk \'{ print $1 }\'); '
        "elif command -v shasum >/dev/null 2>&1; then "
        'actual=$(shasum -a 256 "$temporary" | awk \'{ print $1 }\'); '
        "else echo 'no SHA-256 implementation found' >&2; exit 1; fi; "
        f"test \"$actual\" = {shlex.quote(binary_sha256)}; "
        f'cp "$temporary" {shlex.quote(destination)}; '
        f"chmod 0755 {shlex.quote(destination)}"
    )


class NanocodexAgent(BaseInstalledAgent):
    """Upload one Rust binary, run it once, and retain its JSONL."""

    SUPPORTS_ATIF = True
    _BINARY = "/installed-agent/nanocodex"
    _EVENTS = "/logs/agent/events.jsonl"
    _EVENTS_TMP = "/logs/agent/events.jsonl.tmp"
    _STDERR = "/logs/agent/stderr.log"
    _API_KEY_FILE = "/installed-agent/.openai-api-key"
    _REMOTE_AGENTS_MD = "/app/AGENTS.md"

    def __init__(
        self,
        logs_dir: Path,
        binary_path: str | Path = ".nanocodex/installed/nanocodex",
        binary_url: str | None = None,
        binary_sha256: str | None = None,
        model_name: str | None = None,
        effort: str = "low",
        web_search: bool = True,
        turbo: bool = False,
        install_node: bool = False,
        system_prompt_path: str | Path | None = None,
        agents_md_path: str | Path | None = None,
        extra_env: dict[str, str] | None = None,
        **kwargs: Any,
    ) -> None:
        agent_env = dict(extra_env or {})
        self._api_key = agent_env.pop("OPENAI_API_KEY", None)
        if not self._api_key or not self._api_key.strip():
            raise ValueError("OPENAI_API_KEY is required")
        super().__init__(
            logs_dir=logs_dir,
            model_name=model_name,
            extra_env=agent_env,
            **kwargs,
        )
        self._binary_path = Path(binary_path).resolve()
        if (binary_url is None) != (binary_sha256 is None):
            raise ValueError("binary_url and binary_sha256 must be configured together")
        if binary_url is not None and not binary_url.startswith("https://"):
            raise ValueError("binary_url must use HTTPS")
        if binary_sha256 is not None and not re.fullmatch(
            r"[0-9a-fA-F]{64}", binary_sha256
        ):
            raise ValueError("binary_sha256 must contain 64 hexadecimal characters")
        self._binary_url = binary_url
        self._binary_sha256 = (
            binary_sha256.lower() if binary_sha256 is not None else None
        )
        self._model = self._api_model_name(model_name)
        if self._model != MODEL:
            raise ValueError(f"nanocodex supports only {MODEL}, got {self._model}")
        self._effort = effort
        self._web_search = web_search
        self._turbo = turbo
        self._install_node = install_node
        self._system_prompt_path = self._resolve_context_file(
            system_prompt_path, "system prompt"
        )
        self._agents_md_path = self._resolve_context_file(agents_md_path, "AGENTS.md")
        self._run_interrupted = False
        self._run_failed = False
        self._post_run_validation_failed = False

    @staticmethod
    def name() -> str:
        return "nanocodex"

    def get_version_command(self) -> str:
        return f"{self._BINARY} --version"

    async def install(self, environment: BaseEnvironment) -> None:
        binary_url = getattr(self, "_binary_url", None)
        binary_sha256 = getattr(self, "_binary_sha256", None)
        if binary_url is None and not self._binary_path.is_file():
            raise RuntimeError(
                f"missing nanocodex binary at {self._binary_path}; run `just build-agent`"
            )
        await self.exec_as_root(
            environment,
            _cli_tools_install_command(install_node=self._install_node),
            env={"DEBIAN_FRONTEND": "noninteractive"},
        )
        if binary_url is not None and binary_sha256 is not None:
            await self.exec_as_root(
                environment,
                _remote_binary_install_command(
                    binary_url=binary_url,
                    binary_sha256=binary_sha256,
                    destination=self._BINARY,
                ),
            )
        else:
            await environment.upload_file(self._binary_path, self._BINARY)
            await self.exec_as_root(environment, f"chmod 0755 {self._BINARY}")

    async def _stage_api_key(self, environment: BaseEnvironment) -> None:
        identity = await self.exec_as_agent(environment, "id -u")
        user_id = (identity.stdout or "").strip()
        if not user_id.isdecimal():
            raise RuntimeError("failed to resolve the agent user identifier")

        with tempfile.TemporaryDirectory(prefix="nanocodex-secret-") as directory:
            api_key_path = Path(directory) / "openai-api-key"
            api_key_path.write_text(self._api_key, encoding="utf-8")
            api_key_path.chmod(0o600)
            await environment.upload_file(api_key_path, self._API_KEY_FILE)
        await self.exec_as_root(
            environment,
            f"chown {user_id} {self._API_KEY_FILE} && chmod 0400 {self._API_KEY_FILE}",
        )

    async def _remove_staged_api_key(self, environment: BaseEnvironment) -> None:
        try:
            await self.exec_as_root(environment, f"rm -f {self._API_KEY_FILE}")
        except Exception as error:
            self.logger.warning("failed to remove staged API key: %s", error)

    async def _stage_agents_md(self, environment: BaseEnvironment) -> None:
        agents_md_path = getattr(self, "_agents_md_path", None)
        if agents_md_path is None:
            return
        result = await self.exec_as_agent(
            environment,
            "test ! -e /app/AGENTS.md && test ! -e /app/AGENTS.override.md",
        )
        if result.return_code != 0:
            raise RuntimeError(
                "context-parity eval refuses to replace an existing /app/AGENTS.md "
                "or /app/AGENTS.override.md"
            )
        await environment.upload_file(agents_md_path, self._REMOTE_AGENTS_MD)
        await self.exec_as_root(environment, f"chmod 0444 {self._REMOTE_AGENTS_MD}")

    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        self._run_interrupted = False
        self._run_failed = False
        self._post_run_validation_failed = False
        try:
            await self._run_to_completion(instruction, environment, context)
        except asyncio.CancelledError:
            self._run_interrupted = True
            raise
        except Exception:
            self._run_failed = True
            raise

    async def _run_to_completion(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        del context
        prompt = {"instruction": instruction}
        input_path = self.logs_dir / "input.jsonl"
        input_path.write_text(
            json.dumps(prompt, separators=(",", ":")) + "\n", encoding="utf-8"
        )
        await self._stage_agents_md(environment)
        arguments = self._run_arguments(instruction)
        agent_command = (
            f'api_key=$(<{self._API_KEY_FILE}) && test -n "$api_key" && '
            f'rm -f {self._API_KEY_FILE} && OPENAI_API_KEY="$api_key" '
            + "PATH=$PATH:/opt/nanocodex-verifier/bin "
            + " ".join(shlex.quote(argument) for argument in arguments)
        )
        command = (
            f"events_tmp={shlex.quote(self._EVENTS_TMP)}; "
            'rm -f "$events_tmp"; set +e; set -o pipefail; '
            f'{agent_command} 2> {shlex.quote(self._STDERR)} | tee "$events_tmp"; '
            'exit "$?"'
        )
        try:
            await self._stage_api_key(environment)
            result = await self.exec_as_agent(environment, command)
        finally:
            await self._remove_staged_api_key(environment)
        self._publish_events(result.stdout)

    def _run_arguments(self, prompt: str) -> list[str]:
        arguments = [
            self._BINARY,
            "run",
            "--thinking",
            self._effort,
            "--web-search",
            str(self._web_search).lower(),
        ]
        if getattr(self, "_turbo", False):
            arguments.append("--turbo")
        arguments.extend(["--", prompt])
        return arguments

    def _classify_exec_error(self, command: str, result: Any) -> Exception:
        # BaseInstalledAgent classifies and raises before returning a nonzero
        # ExecResult. Publish its complete captured stdout on this path too so
        # post-run trajectory construction never reads a bind-mounted writer.
        self._publish_events(result.stdout)
        return super()._classify_exec_error(command, result)

    def _publish_events(self, stdout: str | None) -> None:
        if stdout is None:
            return
        events = self.logs_dir / Path(self._EVENTS).name
        temporary = events.with_name(f"{events.name}.host.tmp")
        temporary.write_text(stdout, encoding="utf-8")
        temporary.replace(events)
        (self.logs_dir / Path(self._EVENTS_TMP).name).unlink(missing_ok=True)

    def populate_context_post_run(self, context: AgentContext) -> None:
        if getattr(self, "_post_run_validation_failed", False):
            self.logger.debug(
                "skipping repeated nanocodex trajectory validation during recovery"
            )
            return
        try:
            self._populate_context_post_run_strict(context)
        except Exception:
            if not (
                getattr(self, "_run_interrupted", False)
                or getattr(self, "_run_failed", False)
            ):
                # Harbor records the first validation failure on the trial, then
                # calls this hook again while recovering outputs. Preserve the
                # original strict failure but do not let the recovery pass raise
                # a second time and cancel the entire concurrent job.
                self._post_run_validation_failed = True
                raise
            self.logger.debug(
                "skipping strict nanocodex trajectory validation after an incomplete run",
                exc_info=True,
            )

    def _populate_context_post_run_strict(self, context: AgentContext) -> None:
        prompts = self._read_jsonl(self.logs_dir / "input.jsonl")
        if len(prompts) != 1 or not isinstance(prompts[0].get("instruction"), str):
            raise RuntimeError("input.jsonl must contain one prompt")
        prompt = prompts[0]

        events = self._read_jsonl(self.logs_dir / "events.jsonl")
        if not events or not isinstance(events[0].get("request_id"), str):
            raise RuntimeError("events.jsonl must contain a request ID")
        request_id = events[0]["request_id"]
        for seq, event in enumerate(events, start=1):
            if (
                event.get("protocol_version") != PROTOCOL_VERSION
                or event.get("request_id") != request_id
                or event.get("seq") != seq
                or not isinstance(event.get("type"), str)
                or not isinstance(event.get("payload"), dict)
            ):
                raise RuntimeError(f"invalid nanocodex event at sequence {seq}")
        self._verify_model_context(events)

        terminals = [event for event in events if event["type"] in TERMINAL_EVENTS]
        if len(terminals) != 1:
            raise RuntimeError(
                f"expected exactly one terminal event, found {len(terminals)}"
            )
        terminal = terminals[0]
        if terminal["seq"] != events[-1]["seq"]:
            raise RuntimeError("the terminal event must be the final event")
        terminal_payload = terminal["payload"]
        model_calls = terminal_payload.get("model_calls", 0)
        tool_calls = sum(event["type"] == "tool.call" for event in events)
        usage = terminal_payload.get("usage")
        usage = usage if isinstance(usage, dict) else {}
        warmup_usage = terminal_payload.get("warmup_usage")
        warmup_usage = warmup_usage if isinstance(warmup_usage, dict) else {}
        runtime_metrics = {
            field: terminal_payload.get(field) for field in RUN_METRIC_FIELDS
        }
        runtime_metrics["warmup_usage"] = warmup_usage
        runtime_metrics.update(
            {field: usage.get(field) for field in USAGE_METRIC_FIELDS}
        )
        input_tokens = self._optional_int(usage.get("input_tokens"))
        cached_tokens = self._optional_int(usage.get("cached_input_tokens"))
        output_tokens = self._optional_int(usage.get("output_tokens"))
        cost_usd = self._optional_float(terminal_payload.get("cost_usd"))
        reasoning = "".join(
            event["payload"].get("text", "")
            for event in events
            if event["type"] == "reasoning.summary.delta"
            and isinstance(event["payload"].get("text"), str)
        )
        atif_tool_calls = self._atif_tool_calls(events)
        observations = self._atif_observations(events, atif_tool_calls)
        message = next(
            (
                event["payload"].get("text", "")
                for event in reversed(events)
                if event["type"] == "assistant.message"
            ),
            "Nanocodex emitted no assistant message.",
        )

        trajectory = Trajectory(
            session_id=request_id,
            agent=Agent(
                name=self.name(),
                version=self.version() or "unknown",
                model_name=terminal_payload.get("model"),
                extra={
                    "transport": terminal_payload.get("transport"),
                    "orchestration": terminal_payload.get("orchestration"),
                },
            ),
            steps=[
                Step(
                    step_id=1,
                    source="user",
                    message=prompt["instruction"],
                ),
                Step(
                    step_id=2,
                    source="agent",
                    message=message,
                    model_name=terminal_payload.get("model"),
                    reasoning_effort=terminal_payload.get("effort"),
                    reasoning_content=reasoning or None,
                    tool_calls=atif_tool_calls or None,
                    observation=(
                        Observation(results=observations) if observations else None
                    ),
                    metrics=Metrics(
                        prompt_tokens=input_tokens,
                        completion_tokens=output_tokens,
                        cached_tokens=cached_tokens,
                        cost_usd=cost_usd,
                        extra=runtime_metrics,
                    )
                    if model_calls
                    else None,
                    llm_call_count=model_calls,
                    extra={
                        "terminal_event_type": terminal["type"],
                        "terminal_payload": terminal_payload,
                    },
                ),
            ],
            notes=None,
            final_metrics=FinalMetrics(
                total_prompt_tokens=input_tokens,
                total_completion_tokens=output_tokens,
                total_cached_tokens=cached_tokens,
                total_cost_usd=cost_usd,
                total_steps=2,
                extra={
                    "model_calls": model_calls,
                    "tool_calls": tool_calls,
                    "duration_ns": terminal_payload.get("duration_ns"),
                    **runtime_metrics,
                },
            ),
        )
        (self.logs_dir / "trajectory.json").write_text(
            format_trajectory_json(trajectory.to_json_dict()), encoding="utf-8"
        )

        context.n_input_tokens = input_tokens
        context.n_cache_tokens = cached_tokens
        context.n_output_tokens = output_tokens
        context.cost_usd = cost_usd
        context.metadata = {
            "protocol_version": PROTOCOL_VERSION,
            "terminal_event_type": terminal["type"],
            "model_calls": model_calls,
            "tool_calls": tool_calls,
            "model": terminal_payload.get("model"),
            "effort": terminal_payload.get("effort"),
            "transport": terminal_payload.get("transport"),
            "orchestration": terminal_payload.get("orchestration"),
            "duration_ms": terminal_payload.get("duration_ms"),
            "duration_ns": terminal_payload.get("duration_ns"),
            **runtime_metrics,
            "last_response_id": terminal_payload.get("last_response_id"),
            "cost_status": terminal_payload.get("cost_status"),
        }

    def _verify_model_context(self, events: list[dict[str, Any]]) -> None:
        system_prompt_path = getattr(self, "_system_prompt_path", None)
        agents_md_path = getattr(self, "_agents_md_path", None)
        if system_prompt_path is None and agents_md_path is None:
            return

        input_texts = []
        for event in events:
            if event.get("type") != "api.event":
                continue
            api_event = event.get("payload", {}).get("event", {})
            if not isinstance(api_event, dict):
                continue
            for item in api_event.get("input", []):
                if not isinstance(item, dict):
                    continue
                for block in item.get("content", []):
                    if isinstance(block, dict) and isinstance(block.get("text"), str):
                        input_texts.append(block["text"])

        if system_prompt_path is not None:
            expected = system_prompt_path.read_text(encoding="utf-8").strip()
            if expected not in (text.strip() for text in input_texts):
                raise RuntimeError(
                    "the nanocodex request did not contain the configured system prompt "
                    "byte-for-byte; rebuild the installed agent"
                )

        if agents_md_path is not None:
            agents_md = agents_md_path.read_text(encoding="utf-8")
            expected = (
                "# AGENTS.md instructions for /app\n\n"
                f"<INSTRUCTIONS>\n{agents_md}\n</INSTRUCTIONS>"
            )
            if expected not in input_texts:
                raise RuntimeError(
                    "the nanocodex request did not contain the configured AGENTS.md "
                    "byte-for-byte"
                )

    @staticmethod
    def _resolve_context_file(path: str | Path | None, description: str) -> Path | None:
        if path is None:
            return None
        resolved = Path(path).resolve()
        if not resolved.is_file():
            raise ValueError(f"{description} file does not exist: {resolved}")
        return resolved

    @staticmethod
    def _api_model_name(model_name: str | None) -> str:
        if model_name is None:
            return MODEL
        _, separator, api_model = model_name.partition("/")
        return api_model if separator else model_name

    @staticmethod
    def _optional_int(value: Any) -> int | None:
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    @staticmethod
    def _optional_float(value: Any) -> float | None:
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
        return None

    @staticmethod
    def _atif_tool_calls(events: list[dict[str, Any]]) -> list[ToolCall]:
        calls = []
        for event in events:
            if event["type"] != "tool.call":
                continue
            payload = event["payload"]
            arguments = payload.get("arguments")
            if not isinstance(arguments, dict):
                arguments = {"raw": arguments}
            calls.append(
                ToolCall(
                    tool_call_id=str(payload.get("call_id", "")),
                    function_name=str(payload.get("tool", "")),
                    arguments=arguments,
                    extra={
                        "model_call_index": payload.get("model_call_index"),
                    },
                )
            )
        return calls

    @staticmethod
    def _atif_observations(
        events: list[dict[str, Any]], calls: list[ToolCall]
    ) -> list[ObservationResult]:
        call_ids = {call.tool_call_id for call in calls}
        observations = []
        for event in events:
            if event["type"] != "tool.result":
                continue
            payload = event["payload"]
            call_id = str(payload.get("call_id", ""))
            if call_id not in call_ids:
                continue
            result = payload.get("result", payload)
            observations.append(
                ObservationResult(
                    source_call_id=call_id,
                    content=json.dumps(result, separators=(",", ":")),
                    extra={
                        "status": payload.get("status"),
                        "duration_ns": payload.get("duration_ns"),
                    },
                )
            )
        return observations

    @staticmethod
    def _read_jsonl(path: Path) -> list[dict[str, Any]]:
        deadline = time.monotonic() + 30.0
        while True:
            try:
                text = path.read_text(encoding="utf-8")
                values = [
                    json.loads(line)
                    for line in text.splitlines()
                    if line.strip()
                ]
                break
            except OSError as error:
                if time.monotonic() >= deadline:
                    raise RuntimeError(
                        f"failed to read JSONL from {path}: {error}"
                    ) from error
                time.sleep(0.05)
            except json.JSONDecodeError as error:
                # A bind-mounted file can become visible before its current final
                # record. Stable malformed JSONL ends in a newline and should fail
                # immediately; a partial EOF is allowed time to finish propagating.
                if text.endswith(("\n", "\r")) or time.monotonic() >= deadline:
                    raise RuntimeError(
                        f"failed to read JSONL from {path}: {error}"
                    ) from error
                time.sleep(0.05)
        if not all(isinstance(value, dict) for value in values):
            raise RuntimeError(f"all JSONL values in {path} must be objects")
        return values
