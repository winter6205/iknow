"""Harbor installed-agent adapter that drives the iknow CLI inside a task container.

iknow is not published (package.json `private: true`, no publishConfig), so
`npm install -g iknow` is not a delivery option: install() uploads a host-built
production bundle tarball instead.
"""

import json
import os
import platform
import shlex
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from typing import Annotated, Any, ClassVar, Literal, cast, override

from harbor.agents.installed.base import (
    AgentAuthenticationError,
    BaseInstalledAgent,
    ErrorPattern,
    ModelNotFoundError,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.agents.installed.node_install import nvm_node_install_snippet
from harbor.agents.options import Env, InstalledAgentOptions
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths
from pydantic import Field

from .ask_output import ParsedRun, parse_iknow_ask_output

MINIMAX_PROVIDER_ID = "minimax-cn"
# Harbor's built-in `minimax` provider entry points at api.minimax.io, a
# different host than the benchmark endpoint, so the route is declared here
# rather than reused from there.
MINIMAX_BASE_URL = "https://api.minimaxi.com/anthropic"
MINIMAX_API_KEY_ENV = "MINIMAX_API_KEY"
CONTEXT_WINDOW_TOKENS = 1_000_000
MAX_OUTPUT_TOKENS = 128_000
NODE_MAJOR_FLOOR = 20

PERMISSION_MODE_ENV = "IKNOW_PERMISSION_MODE"
EVAL_STATE_ENV = "IKNOW_EVAL_STATE"
BUNDLE_PATH_ENV = "IKNOW_BUNDLE_TGZ"
# Mirrors EVAL_STATE_FLAG in src/harness/sandbox/eval-state.ts: eval state is
# carried by argv, because iknow reads no eval-state env var at all.
EVAL_STATE_FLAG = "--eval-state"
# Mirrors EVAL_STATE_RUN_LABEL in src/harness/sandbox/eval-state.ts: the string
# iknow puts in the ask JSON to name the state the number came from.
EVAL_STATE_RUN_LABEL = "eval_state"

_REMOTE_BUNDLE = PurePosixPath("/tmp/iknow-bundle.tgz")
_INSTALL_DIR_NAME = "iknow"
_SETTINGS_DIR_NAME = ".iknow"
_OUTPUT_FILENAME = "iknow-ask.txt"
_MAX_TURNS_ERROR = "max_turns_exceeded"

_NODE_VERSION_PROBE = (
    "process.exit(Number(process.versions.node.split('.')[0]) >= "
    f"{NODE_MAJOR_FLOOR} ? 0 : 1)"
)
# Printed by the first leg of the smoke test, so "node ran but the addons
# failed" is a fact the container reports rather than something guessed from
# the failure text. A failure-text matcher is deliberately not also consulted:
# "No such file or directory" is what a missing shared library looks like, and
# that arrives after the marker, not before it.
_NODE_MARKER = "iknow-node-runnable"
_NODE_MARKER_PROBE = f"console.log('{_NODE_MARKER}')"
# tree-sitter is imported lazily by the bash tool, so `--version` alone does not
# prove the native addons load; importing them explicitly does.
_NATIVE_PROBE = (
    "import('tree-sitter')"
    ".then(() => import('tree-sitter-bash'))"
    ".then("
    "() => console.log('iknow-native-ok'), "
    "(error) => { console.error(String(error && error.message)); process.exit(1); })"
)


class IKnowInstallError(RuntimeError):
    """Environment cannot host iknow; raised before the trial runs any step."""


class IKnowBundleMissingError(IKnowInstallError):
    """The host-side production bundle tarball is absent or unreadable."""


class IKnowGlibcRequiredError(IKnowInstallError):
    """musl/Alpine or a foreign architecture cannot load the shipped prebuilds."""


class IKnowNodeUnavailableError(IKnowInstallError):
    """No runnable `node` is on the container PATH, so the smoke test never ran.

    Distinct from `IKnowGlibcRequiredError` because a libc or architecture
    mismatch only exists once node has actually executed the bundle.
    """


class IKnowEvalStateUnsupportedError(IKnowInstallError):
    """The uploaded bundle's CLI does not carry the `--eval-state` flag."""


class IKnowRunStateMismatchError(RuntimeError):
    """The run's own `runState` disagrees with the posture the trial requested."""


class IKnowOptions(InstalledAgentOptions):
    bundle_path: Annotated[
        str | None,
        Env(BUNDLE_PATH_ENV, fallback=BUNDLE_PATH_ENV),
    ] = Field(
        default=None,
        description="Host path to the production bundle tarball (see README).",
    )
    permission_mode: Annotated[
        Literal["default", "plan", "full_auto"],
        Env(PERMISSION_MODE_ENV, fallback=PERMISSION_MODE_ENV),
    ] = Field(
        default="full_auto",
        description=(
            "Value injected as IKNOW_PERMISSION_MODE. `ask` denies every mutation "
            "under `default` and still exits 0, which would score as a real 0, so "
            "the mode is always passed explicitly instead of inherited."
        ),
    )
    eval_state: Annotated[
        bool,
        Env(
            EVAL_STATE_ENV,
            fallback=EVAL_STATE_ENV,
            true_value="1",
            false_value="0",
        ),
    ] = Field(
        default=False,
        description=(
            "Run the trial in ADR-0130 eval state (the bwrap fence retires). "
            "Reaches iknow as the named `--eval-state` argv flag on the `ask` "
            "command, never as an in-container env var: iknow reads no such env "
            "(ADR-0130 §1 bans the silent form), and setup refuses a bundle that "
            "does not advertise the flag. This host-side env only selects the "
            "option for Harbor."
        ),
    )
    max_turns: int | None = Field(
        default=None,
        ge=1,
        description="--max-turns for `iknow ask`. Omitted = iknow's default.",
    )


def _nvm_version_major(path: str) -> int | None:
    """Parse the major out of `$NVM_DIR/versions/node/vX.Y.Z/bin/node`.

    Returns None for anything that is not an nvm node binary, including a
    version directory nvm writes for aliases or custom builds whose name is
    not a plain `vN.N.N` triple. Parsing is what makes the selection immune to
    the byte ordering of the listing that produced the path.
    """
    parts = PurePosixPath(path.rstrip("/")).parts
    if len(parts) < 4 or parts[-2] != "bin" or parts[-1] != "node":
        return None
    version = parts[-3]
    if not version.startswith("v"):
        return None
    major = version[1:].split(".", 1)[0]
    return int(major) if major.isdigit() else None


def render_iknow_settings(model_route: str) -> str:
    """Render the container-side ~/.iknow/settings.json for one model route.

    Only the key *name* is written; the value reaches `ask` through the exec
    environment, so no credential lands in an uploaded file.
    """
    provider_id, separator, model_id = model_route.partition("/")
    if not separator or not model_id or provider_id != MINIMAX_PROVIDER_ID:
        raise ValueError(
            f"iknow model route must be {MINIMAX_PROVIDER_ID!r} + '/<model-id>' "
            f"(MINIMAX_BASE_URL is declared for that provider only); got "
            f"{model_route!r}"
        )
    settings = {
        "llm": {
            "model": model_route,
            "providers": [
                {
                    "id": provider_id,
                    "baseUrl": MINIMAX_BASE_URL,
                    "apiKeyEnv": MINIMAX_API_KEY_ENV,
                    "models": [
                        {
                            "id": model_id,
                            "name": model_id,
                            "contextWindow": CONTEXT_WINDOW_TOKENS,
                            "maxTokens": MAX_OUTPUT_TOKENS,
                        }
                    ],
                }
            ],
        }
    }
    return json.dumps(settings, indent=2) + "\n"


class IKnowAgent(BaseInstalledAgent):
    """Runs one task instruction through `iknow ask --json` in the task image."""

    ERROR_PATTERNS: ClassVar[list[ErrorPattern]] = [
        *BaseInstalledAgent.ERROR_PATTERNS,
        # iknow's own typed provider-config messages (src/config/env.ts).
        ErrorPattern(r"provider_api_key_missing", AgentAuthenticationError),
        ErrorPattern(r"provider_model_not_registered", ModelNotFoundError),
        # Observed live reply from MINIMAX_BASE_URL for a bad key; harbor's base
        # auth patterns only cover other vendors' wording.
        ErrorPattern(
            r"\bauthentication_error\b|login fail: Please carry the API secret key",
            AgentAuthenticationError,
        ),
    ]
    options_model = IKnowOptions

    def __init__(self, *args: Any, logs_dir: Path, **kwargs: Any) -> None:
        super().__init__(*args, logs_dir=logs_dir, **kwargs)
        self._remote_home: str | None = None

    @staticmethod
    @override
    def name() -> str:
        return "iknow"

    @override
    def get_version_command(self) -> str | None:
        return f'cd "$HOME/{_INSTALL_DIR_NAME}" && node ./dist/cli.js --version'

    @classmethod
    @override
    def preflight(
        cls,
        kwargs: dict[str, Any] | None = None,
        env: Mapping[str, str] | None = None,
    ) -> None:
        options = cast(IKnowOptions, cls.parse_options(kwargs, env))
        bundle = options.bundle_path
        if bundle is None or not Path(bundle).is_file():
            raise ValueError(
                f"iknow bundle tarball not found at {bundle!r}. Build it first "
                "with ./scripts/harbor/build-bundle.sh, then pass "
                f"--ak bundle_path=... or --ae {BUNDLE_PATH_ENV}=..."
            )
        if not _env_value(env, MINIMAX_API_KEY_ENV):
            raise ValueError(
                f"{MINIMAX_API_KEY_ENV} is not set. Pass it with --ae "
                f"{MINIMAX_API_KEY_ENV}=${MINIMAX_API_KEY_ENV}; the adapter never "
                "bakes a key into the settings file it uploads."
            )

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        bundle = Path(cast(IKnowOptions, self.options).bundle_path or "")
        if not bundle.is_file():
            raise IKnowBundleMissingError(
                f"iknow bundle tarball missing on the host: {bundle}"
            )
        # Resolved first: a bad --model should fail before the container spends
        # minutes installing node and unpacking the bundle.
        self._settings_text()
        home = await self._agent_home(environment)
        await self._reject_musl(environment)
        await self._ensure_node(environment)
        await self._unpack_bundle(environment, bundle, home)
        await self._assert_bundle_runtime(environment, home)
        await self._assert_eval_state_flag(environment, home)
        await self._upload_settings(environment, home)

    @override
    @with_prompt_template
    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        options = cast(IKnowOptions, self.options)
        home = await self._agent_home(environment)
        command = self._ask_command(instruction, options, home)
        self.logger.debug(f"Running iknow ask: {command}")
        result = await environment.exec(command=command, env=self._runtime_env(options))
        parsed = parse_iknow_ask_output(result.stdout or "")
        if _is_capped_turn_run(parsed, result.return_code):
            self.logger.warning(
                "iknow hit its turn budget; scoring the partial run instead of "
                "erroring the trial"
            )
            context.metadata = _run_metadata(parsed, options)
            return
        if result.return_code != 0:
            raise self._classify_exec_error(command, result)
        if parsed.kind == "none":
            raise NonZeroAgentExitCodeError(
                "iknow ask exited 0 but printed no JSON object. Output: "
                f"{self._truncate_output(result.stdout)}"
            )
        self._assert_run_state_named(parsed, options)
        _apply_to_context(parsed, context, options)

    def _assert_run_state_named(
        self, parsed: ParsedRun, options: IKnowOptions
    ) -> None:
        """Second net behind `_assert_eval_state_flag`: check the label the run gave itself.

        ADR-0130 §5 makes the produced number carry its own state, and
        `formatRunJson` puts `runState` on the answer payload — the only payload
        that carries it, and only when a state was named, since the key is
        dropped for every other posture. So a trial that asked for eval state but
        got an answer without the label, or one that asked for the fence and got
        the label, produced a number that cannot be attributed, which is exactly
        what the invariant forbids. Only an answer is checked: the error
        envelopes that carry a capped or failed run have no `runState` key at all,
        and their own error is the finding.
        """
        if parsed.kind != "answer":
            return
        named = parsed.run_state == EVAL_STATE_RUN_LABEL
        if named == options.eval_state:
            return
        raise IKnowRunStateMismatchError(
            f"ask returned an answer with runState={parsed.run_state!r} while the "
            f"trial requested eval_state={options.eval_state}. The number cannot "
            "be attributed to either posture (ADR-0130 §5), so the trial errors "
            "instead of being scored."
        )

    async def _agent_home(self, environment: BaseEnvironment) -> str:
        if self._remote_home is not None:
            return self._remote_home
        result = await environment.exec(command='printf %s "$HOME"')
        home = (result.stdout or "").strip()
        if not home.startswith("/"):
            raise IKnowInstallError(
                f"Could not resolve $HOME in the task container (got {home!r})"
            )
        self._remote_home = home
        return home

    async def _reject_musl(self, environment: BaseEnvironment) -> None:
        result = await environment.exec(
            command=(
                "if ldd --version 2>&1 | grep -qi musl || "
                "[ -f /etc/alpine-release ]; then echo musl; fi"
            ),
            user="root",
        )
        if "musl" in (result.stdout or ""):
            raise IKnowGlibcRequiredError(
                "Task image is musl-based (Alpine): iknow's tree-sitter and "
                "tree-sitter-bash addons ship glibc prebuilds only."
            )

    async def _ensure_node(self, environment: BaseEnvironment) -> None:
        await self.ensure_system_dependencies(environment, ("curl", "bash", "tar"))
        check = await environment.exec(
            command=(
                'if [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh"; fi; '
                f"node -e {shlex.quote(_NODE_VERSION_PROBE)}"
            )
        )
        if check.return_code == 0:
            # The probe above sources nvm.sh when it can, so passing here does
            # not prove a fresh shell can see node. On a kept container with a
            # pre-existing nvm that is exactly the difference between exit 0
            # here and "node: command not found" in run(), so the check is
            # repeated without nvm before the symlink step is skipped.
            plain = await environment.exec(
                command=f"node -e {shlex.quote(_NODE_VERSION_PROBE)}"
            )
            if plain.return_code == 0:
                return
            await self._link_node_onto_system_path(environment)
            return
        await self.exec_as_agent(
            environment,
            command=f"set -euo pipefail; {nvm_node_install_snippet()}",
            env={"NVM_NODEJS_ORG_MIRROR": "https://nodejs.org/dist"},
        )
        await self._link_node_onto_system_path(environment)

    async def _link_node_onto_system_path(self, environment: BaseEnvironment) -> None:
        """Put the nvm-installed node on a PATH that needs no nvm sourcing.

        Every later `environment.exec()` starts a fresh non-login shell, and
        such a shell cannot see `$NVM_DIR/versions/node/*/bin`. So the binary is
        located inside the nvm tree by its own layout — the version directory
        nvm just created — and never by `command -v node`, which reports
        whatever the ambient PATH happens to carry.

        The listing runs in the agent's own context because the nvm tree lives
        under the agent's `$HOME` and is not necessarily readable by root's
        shell; only the resolved path is then handed to `exec_as_root`, and
        `/usr/local/bin` is on root's PATH by the same token.

        **Selection policy: the highest major at or above `NODE_MAJOR_FLOOR`.**
        The listing itself is byte-sorted, so it must not be trusted for order:
        a tree holding v9.11.2, v18.20.4 and v22.23.3 lists v9.11.2 *last*,
        and linking that "last" entry gives a real, runnable node 9 that
        `dist/cli.js` cannot be parsed by. The major is therefore parsed out of
        each candidate and compared numerically. A tree whose every candidate is
        below the floor is an error, not a downgrade: the floor is a hard
        precondition of the bundle, and the post-link probe re-checks the
        binary that was actually linked.

        A failure here is raised instead of skipped: a node that exists solely
        under `$NVM_DIR` fails later, once, in `_assert_bundle_runtime`, as
        "node: command not found".
        """
        result = await environment.exec(
            command=(
                "sh -c 'ls -1 \"${NVM_DIR:-$HOME/.nvm}/versions/node/\"*/bin/node"
                " 2>/dev/null'"
            )
        )
        binary = self._select_nvm_node(result)
        await self.exec_as_root(
            environment,
            command=f"ln -sf {shlex.quote(binary)} /usr/local/bin/node",
        )
        # A dangling symlink is silent until run() fails deep inside a task, so
        # the link is proven here by resolving it in a shell with no nvm. The
        # probe is the floor check rather than a bare `--version`, so the floor
        # follows the binary actually linked even if the path above picked the
        # wrong entry: the container is the authority on its own node.
        linked = await environment.exec(
            command=f"node -e {shlex.quote(_NODE_VERSION_PROBE)}"
        )
        if linked.return_code != 0:
            raise IKnowNodeUnavailableError(
                f"linked {binary} to /usr/local/bin/node, but a plain shell "
                f"cannot run a node at major {NODE_MAJOR_FLOOR} or newer from it, "
                "so every later step would fail with 'node: command not found' "
                "or with a CLI the bundle does not support. stdout: "
                f"{self._truncate_output(linked.stdout)} / stderr: "
                f"{self._truncate_output(linked.stderr)}"
            )

    def _select_nvm_node(self, result: Any) -> str:
        """Pick the highest nvm node at or above the floor, or raise.

        The listing arrives byte-sorted, so the *last* line is the oldest
        single-digit major (v9 sorts after v22), not the newest. Candidates are
        ranked by their parsed major instead, and the post-link probe re-checks
        whatever was chosen.
        """
        candidates: list[tuple[int, str]] = []
        for line in (result.stdout or "").splitlines():
            path = line.strip()
            major = _nvm_version_major(path)
            if path.startswith("/") and major is not None:
                candidates.append((major, path))
        if not candidates:
            raise IKnowNodeUnavailableError(
                "nvm reported a successful install but no node binary exists "
                "under $NVM_DIR/versions/node/*/bin, so nothing can be put on "
                "the system PATH. The nvm tree listed: "
                f"{self._truncate_output(result.stdout)}"
            )
        eligible = [entry for entry in candidates if entry[0] >= NODE_MAJOR_FLOOR]
        if not eligible:
            raise IKnowNodeUnavailableError(
                f"every node under $NVM_DIR/versions/node/*/bin is below major "
                f"{NODE_MAJOR_FLOOR} (found "
                f"{', '.join(path for _major, path in candidates)}), and "
                f"iknow's bundle cannot be parsed by a node that old, so no "
                "binary is linked rather than linking one that would fail later."
            )
        return max(eligible)[1]

    async def _unpack_bundle(
        self, environment: BaseEnvironment, bundle: Path, home: str
    ) -> None:
        target = self._install_dir(home)
        await self._upload_agent_owned_file(environment, bundle, str(_REMOTE_BUNDLE))
        await self.exec_as_agent(
            environment,
            command=(
                f"mkdir -p {target} && tar xzf {shlex.quote(str(_REMOTE_BUNDLE))} "
                f"-C {target} && {{ rm -f {shlex.quote(str(_REMOTE_BUNDLE))} || true; }}"
            ),
        )

    async def _assert_bundle_runtime(
        self, environment: BaseEnvironment, home: str
    ) -> None:
        target = self._install_dir(home)
        # The first leg prints a marker whether or not the CLI behind it loads,
        # so "node ran" is a fact from the container, not a guess from the
        # failure text; the CLI runs after it, so its own output still ends the
        # combined stream.
        command = (
            f"cd {target} && node -e {shlex.quote(_NODE_MARKER_PROBE)} && "
            f"node ./dist/cli.js --version && "
            f"node -e {shlex.quote(_NATIVE_PROBE)}"
        )
        result = await environment.exec(command=command)
        if result.return_code != 0:
            raise self._smoke_test_error(result)

    def _smoke_test_error(self, result: Any) -> IKnowInstallError:
        """Say which half of the smoke test failed, not just that one did.

        A missing or unrunnable node is an install problem with a different
        remedy than a foreign libc, and reporting the latter for the former
        sends the reader to the wrong place.
        """
        stdout = result.stdout or ""
        stderr = result.stderr or ""
        # Only the marker decides "did node run". Matching the failure text
        # instead would misattribute the exact case the marker exists to catch:
        # a slim image missing a shared library fails with "No such file or
        # directory" *after* node printed the marker, and a command-not-found
        # regex would report "node never ran" for a node that plainly did.
        if _NODE_MARKER not in stdout:
            return IKnowNodeUnavailableError(
                f"iknow bundle smoke test failed (exit {result.return_code}) "
                f"before node ran anything: the container has no runnable "
                f"`node` on the PATH these commands see, so the bundle was "
                f"never loaded and this says nothing about glibc or "
                f"architecture. Check that node is linked on the system PATH "
                f"(e.g. /usr/local/bin/node) and not only inside nvm's "
                f"per-shell PATH. stdout: {self._truncate_output(stdout)} / "
                f"stderr: {self._truncate_output(stderr)}"
            )
        return IKnowGlibcRequiredError(
            f"iknow bundle smoke test failed (exit {result.return_code}) after "
            f"node ran. The bundle is built for {platform.machine()} glibc on "
            "the host; a different architecture or libc in the task image breaks "
            f"the native addons. stdout: {self._truncate_output(stdout)} / "
            f"stderr: {self._truncate_output(stderr)}"
        )

    async def _assert_eval_state_flag(
        self, environment: BaseEnvironment, home: str
    ) -> None:
        """Prove the installed CLI can name the posture before trusting the label.

        `ask` joins unrecognized positionals into the instruction, so handing
        `--eval-state` to a bundle built before the entry landed would fold the
        token into the prompt and still record `eval_state: true` on the trial.
        ADR-0130 §5 requires the number to name the state it came from, so a
        bundle that cannot name it is a refusal rather than a mislabel.
        """
        options = cast(IKnowOptions, self.options)
        if not options.eval_state:
            return
        result = await environment.exec(
            command=f"cd {self._install_dir(home)} && node ./dist/cli.js --help 2>&1"
        )
        if EVAL_STATE_FLAG not in (result.stdout or ""):
            raise IKnowEvalStateUnsupportedError(
                f"{EVAL_STATE_FLAG} is not offered by the installed CLI, so eval "
                "state cannot be named on the command line (ADR-0130 §1). Rebuild "
                "the bundle from a checkout that carries "
                "src/harness/sandbox/eval-state.ts. help: "
                f"{self._truncate_output(result.stdout)}"
            )

    async def _upload_settings(self, environment: BaseEnvironment, home: str) -> None:
        settings_dir = shlex.quote(f"{home}/{_SETTINGS_DIR_NAME}")
        await self.exec_as_agent(environment, command=f"mkdir -p {settings_dir}")
        await self._upload_config_text(
            environment,
            content=self._settings_text(),
            remote_path=f"{home}/{_SETTINGS_DIR_NAME}/settings.json",
            filename="settings.json",
        )

    def _settings_text(self) -> str:
        return render_iknow_settings(self._model_route())

    def _model_route(self) -> str:
        if not self.model_name:
            raise ValueError(
                "iknow needs --model <provider>/<model> (the iknow route id), e.g. "
                f"--model {MINIMAX_PROVIDER_ID}/MiniMax-M3.1-Flash-Preview"
            )
        return self.model_name

    def _install_dir(self, home: str) -> str:
        return shlex.quote(f"{home}/{_INSTALL_DIR_NAME}")

    def _runtime_env(self, options: IKnowOptions) -> dict[str, str]:
        api_key = self._get_env(MINIMAX_API_KEY_ENV)
        if not api_key:
            raise ValueError(
                f"{MINIMAX_API_KEY_ENV} is not set in the agent environment; pass "
                f"--ae {MINIMAX_API_KEY_ENV}=${MINIMAX_API_KEY_ENV}"
            )
        runtime_env = {
            PERMISSION_MODE_ENV: options.permission_mode,
            MINIMAX_API_KEY_ENV: api_key,
        }
        return runtime_env

    def _ask_command(
        self, instruction: str, options: IKnowOptions, home: str
    ) -> str:
        log_dir = EnvironmentPaths.agent_dir.as_posix()
        max_turns = f" --max-turns {options.max_turns}" if options.max_turns else ""
        eval_state = f" {EVAL_STATE_FLAG}" if options.eval_state else ""
        return (
            "set -o pipefail; "
            f"mkdir -p {shlex.quote(log_dir)} && cd {self._install_dir(home)} && "
            f"node ./dist/cli.js ask {shlex.quote(instruction)} --json{eval_state}"
            f"{max_turns} 2>&1 </dev/null | tee "
            f"{shlex.quote(log_dir)}/{_OUTPUT_FILENAME}"
        )


def _is_capped_turn_run(parsed: ParsedRun, return_code: int) -> bool:
    return (
        return_code != 0
        and parsed.kind == "error_envelope"
        and parsed.error_code == _MAX_TURNS_ERROR
    )


def _run_metadata(parsed: ParsedRun, options: IKnowOptions) -> dict[str, Any]:
    # ADR-0130 reporting invariant: an eval-state number must name its state, so
    # the posture lands on the trial record, not only in the launch command.
    metadata: dict[str, Any] = {
        "permission_mode": options.permission_mode,
        "eval_state": options.eval_state,
    }
    if parsed.error_code is not None:
        metadata["iknow_error"] = parsed.error_code
    if parsed.turn_count is not None:
        metadata["turn_count"] = parsed.turn_count
    return metadata


def _apply_to_context(
    parsed: ParsedRun, context: AgentContext, options: IKnowOptions
) -> None:
    usage = parsed.usage
    if usage is not None:
        # AgentContext.n_input_tokens counts cached tokens (the claude_code
        # adapter convention); iknow reports the three readings separately.
        cached = usage.cache_read_input_tokens or 0
        creation = usage.cache_creation_input_tokens or 0
        context.n_input_tokens = (usage.input_tokens or 0) + cached + creation
        context.n_cache_tokens = cached
        context.n_output_tokens = usage.output_tokens
    metadata = _run_metadata(parsed, options)
    if parsed.stop_reason is not None:
        metadata["stop_reason"] = parsed.stop_reason
    context.metadata = metadata


def _env_value(env: Mapping[str, str] | None, key: str) -> str | None:
    value = (env or {}).get(key)
    return value or os.environ.get(key) or None
