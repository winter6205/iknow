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

# iknow's own env var for the same concern, which `src/cli/trace-root.ts:29`
# honors with *path* semantics. Not this adapter's `Env` fallback — see the
# `trace_out` field. Named here so the exclusion is assertable rather than a
# comment that can drift.
TRACE_OUT_ENV = "IKNOW_TRACE_OUT"
# Mirrors the `--trace-out` flag in src/cli/parse-args.ts.
TRACE_OUT_FLAG = "--trace-out"

_REMOTE_BUNDLE = PurePosixPath("/tmp/iknow-bundle.tgz")
_INSTALL_DIR_NAME = "iknow"
_SETTINGS_DIR_NAME = ".iknow"
_OUTPUT_FILENAME = "iknow-ask.txt"
# `--trace-out` is a *directory* in the ask entry, not the file it looks like:
# src/harness/trace/jsonl.ts:192-197 joins the conversation id onto it, so a
# trial's records land at `<dir>/<conversationId>.jsonl`. The directory is
# therefore named once and shared, and the file name is left to iknow — the
# conversation id is a random UUID the adapter never sees.
_TRACE_DIRNAME = "trace"
_MAX_TURNS_ERROR = "max_turns_exceeded"
# Prints one word naming what is actually on disk in the trace dir, for the
# post-run probe. POSIX sh only: no `find`, no `stat`, no `[[ ]]`. An unmatched
# glob expands to itself literally, so the "no file" case is a comparison
# against the pattern rather than a missing-argument read.
_TRACE_PROBE_PRESENT = "present"
# The conversation id iknow minted inside the container is what a trial's
# trace is joined on, and the file probe that reads it out is a separate
# command from `_trace_probe_command` rather than an extension of it: that
# one's one-word answer is asserted by its own tests, and widening it would
# change what `trace_state` means for every existing reader.
_TRACE_PROBE_EMPTY = "empty"
_TRACE_PROBE_ABSENT = "absent"

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

# The highest `GLIBCXX_x.y.z` the shipped prebuilds reference, measured from
# the bundle tarball rather than read off a failure message:
#   tree-sitter@0.25.1      -> GLIBCXX_3.4.31 (the ceiling)
#   tree-sitter-bash@0.25.1 -> GLIBCXX_3.4.21
# The 3.4.31 reference is a single libstdc++ symbol,
# _ZNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEE15_M_replace_cold...,
# introduced in GCC 12. An image whose libstdc++ predates GCC 12 loads node fine
# and then fails to dlopen the addon, which is what a real Debian 12 trial did.
# The version, not a symbol spelling, is what is compared in the container:
# readelf is absent from most task images, and the version strings are plain
# data in libstdc++.so.6.
REQUIRED_GLIBCXX = "GLIBCXX_3.4.31"

# `apt-get install libstdc++6` on an image that already has it at the repository
# candidate is a no-op that exits 0, so a version check is the only thing that
# can tell "installed" from "new enough". This is not hypothetical: Debian 12's
# libstdc++6 tops out at GLIBCXX_3.4.30, one short of the requirement.
#
# Two things in this command were found by running it against real containers
# rather than by reasoning about it, and both are load-bearing:
#
# - `|| true` inside the loop. `grep` exits 1 when it matches nothing, so every
#   element of the pipeline exits 1, and harbor prepends `set -o pipefail` to
#   every command it runs. Without the guard, an image with no readable
#   libstdc++.so.6 aborted install() with NonZeroAgentExitCodeError instead of
#   reporting "no runtime found" and letting the install run — on precisely the
#   image that most needs the install. Inside the loop, the guard also makes the
#   `[ -r ]` test's own exit status irrelevant.
#
# - `tr -c '[:alnum:]_.'` rather than `grep -a`. `grep -a` is a GNU extension
#   that busybox does not implement (`grep [-HhnlLoqvsrRiwFE]`), so on Alpine
#   the probe silently extracted nothing and reported "none found" even with a
#   current libstdc++ installed. Converting the file to one-token-per-line with
#   `tr` and matching whole lines is POSIX and behaves identically on busybox
#   and GNU. `strings` is not an alternative: it is absent from the Debian task
#   images. (On Alpine's *musl* libstdc++ the answer is a true negative either
#   way — that build carries no GLIBCXX_3.4.x version strings at all, which is
#   consistent with `_reject_musl` refusing the image before this step runs.)
#
# The probe emits *every* match and stops there. It deliberately does not sort:
# `sort -V` is a GNU extension, which is at odds with the POSIX-only rationale
# above, and plain `sort` is not merely cosmetic — the lexicographic maximum of
# a real libstdc++'s tokens is `GLIBCXX_3.4.9`, not `GLIBCXX_3.4.35`, because
# "9" sorts after "3". A lexicographic max therefore fails *closed* but
# wrongly, refusing an image that has the runtime and issuing a pointless
# install first. Picking the maximum numerically is the same code the
# pass/fail decision already uses (`_glibcxx_at_least`), so the ordering has
# exactly one implementation.
_LIBSTDCXX_CANDIDATES = (
    "/usr/lib/x86_64-linux-gnu/libstdc++.so.6",
    "/usr/lib64/libstdc++.so.6",
    "/usr/lib/libstdc++.so.6",
    "/lib/x86_64-linux-gnu/libstdc++.so.6",
)


def _glibcxx_probe_command(candidates: tuple[str, ...]) -> str:
    """Build the probe that prints every `GLIBCXX_x.y.z` the image defines.

    The candidate list is a parameter so a test can point the very same command
    at a fixture, rather than at `/usr/lib`, and run it in a real shell.
    """
    return (
        "for so in "
        + " ".join(shlex.quote(candidate) for candidate in candidates)
        + "; do "
        '[ -r "$so" ] && tr -c "[:alnum:]_." "\\n" < "$so" '
        '| grep -oE "^GLIBCXX_[0-9.]+$" || true; done'
    )


_GLIBCXX_CEILING_PROBE = _glibcxx_probe_command(_LIBSTDCXX_CANDIDATES)

# How to satisfy the C++ runtime, per package manager, as one row: the package
# name (`libstdc++` on Alpine and the RHEL family, the soname-derived
# `libstdc++6` on Debian/Ubuntu), the install command, and the per-exec env it
# needs. Detection is by package manager rather than by os-release, so a task
# image that ships an unexpected base (CentOS Stream, UBI) is still handled by
# the manager that is actually present.
#
# Kept as a single mapping rather than two parallel dicts keyed by the same
# manager set: those could drift, and a manager present in one and absent from
# the other would fail with a bare `KeyError` instead of an error the reader can
# act on. `_cxx_runtime_install` is the only reader, and it raises.
_CXX_RUNTIME_INSTALLS: dict[str, tuple[str, str, dict[str, str] | None]] = {
    # The `apt-get update` prefix is load-bearing, not hygiene. Without it a
    # task image whose package cache is empty or stale fails with "Unable to
    # locate package libstdc++6" — and the repository may well carry a new enough
    # build, with the cache the only thing wrong. Harbor's own dependency
    # installer does both halves (base.py: `apt-get update && apt-get install
    # -y`, plus DEBIAN_FRONTEND=noninteractive); an unanswered debconf prompt
    # would hang the install in a container with no pty rather than fail it.
    "apt-get": (
        "libstdc++6",
        "apt-get update && apt-get install -y --no-install-recommends",
        {"DEBIAN_FRONTEND": "noninteractive"},
    ),
    "apk": ("libstdc++", "apk add --no-cache", None),
    "dnf": ("libstdc++", "dnf install -y", None),
    "yum": ("libstdc++", "yum install -y", None),
}


def _cxx_runtime_install(manager: str) -> tuple[str, str, dict[str, str] | None]:
    """The (package, install command, exec env) row for a known package manager."""
    try:
        return _CXX_RUNTIME_INSTALLS[manager]
    except KeyError:
        raise IKnowInstallError(
            f"no C++-runtime install is defined for package manager {manager!r}; "
            f"supported: {', '.join(sorted(_CXX_RUNTIME_INSTALLS))}"
        ) from None


class IKnowInstallError(RuntimeError):
    """Environment cannot host iknow; raised before the trial runs any step."""


class IKnowBundleMissingError(IKnowInstallError):
    """The host-side production bundle tarball is absent or unreadable."""


class IKnowGlibcRequiredError(IKnowInstallError):
    """musl/Alpine or a foreign architecture cannot load the shipped prebuilds."""


class IKnowCppRuntimeTooOldError(IKnowInstallError):
    """The image's libstdc++ cannot provide the symbol version the addons need.

    Separate from `IKnowGlibcRequiredError` on purpose. That one means the
    image's libc family is wrong for the shipped prebuilds (musl, or a
    foreign architecture) and no package install can change it. This one means
    the libc is fine and the C++ runtime in front of it is merely too old, so
    the remedy is a package — but on some images (Debian 12's GLIBCXX_3.4.30
    ceiling) the distribution has no newer one to install, and saying so is
    the whole point of raising here instead of continuing into a dlopen
    failure inside `_assert_bundle_runtime`.
    """


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
    trace_out: bool = Field(
        default=False,
        description=(
            "Retain the per-turn trajectory as a trial artifact. Off by default: "
            "the pilot (docs/evidence/adr-0130/terminal-bench-2-1-pilot.md §8) "
            "scored two model-attributable trials with no per-turn record kept, "
            "which left the loop diagnosis and the tool-selection reading "
            "unavailable, and left a second hard-wall deny's correctness "
            "'undetermined' because the offending command text was never "
            "captured. With it on, `ask` writes the JSONL trace under the agent "
            "log dir, which harbor copies to `agent/trace/<conversationId>.jsonl` "
            "in the trial directory — the per-turn llm_call / tool_call / turn "
            "records the ask JSON's own `trace` key deliberately drops. "
            "Declared without an `Env` fallback, unlike `permission_mode` / "
            "`eval_state`, and the difference is load-bearing: harbor's env "
            "fallback is not scoped to `--ae` but falls through to the host "
            "process environment (harbor/agents/base.py:178-181), and "
            "IKNOW_TRACE_OUT is a *shipped iknow variable with path semantics* "
            "that src/cli/trace-root.ts:29 already honors. As a boolean option it "
            "would be a name collision, and a bare host export would silently "
            "rewrite a pilot-baseline trial's argv and log-dir tree."
        ),
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


def _glibcxx_components(version: str) -> tuple[int, ...] | None:
    """Split `GLIBCXX_x.y.z` into numeric components, or None if it is not one.

    `isascii()` guards the digit test: `str.isdigit()` is also true for
    superscripts and other non-ASCII digits, and `int()` raises on those, so
    `isdigit()` alone would make this predicate partial. The probe cannot
    produce such a token today (it is anchored to `[0-9.]`), but the predicate
    is a total function or it is a latent crash.
    """
    prefix, _, rest = version.partition("_")
    if prefix != "GLIBCXX" or not rest:
        return None
    components = rest.split(".")
    if not components or not all(
        part.isascii() and part.isdigit() for part in components
    ):
        return None
    return tuple(int(part) for part in components)


def _glibcxx_at_least(observed: str | None, required: str) -> bool:
    """Compare a `GLIBCXX_x.y.z` ceiling against the version the addons need.

    Numeric component comparison, not string comparison: "3.4.9" sorts after
    "3.4.30" lexicographically, so a string ordering would accept an image
    that is eleven releases short. Anything unparseable — including the empty
    string an image with no readable libstdc++.so.6 reports — is treated as not
    satisfying the requirement, so an unreadable probe leads to the install
    attempt and, failing that, to a clear error rather than a silent pass.
    """
    observed_parts = _glibcxx_components(observed.strip()) if observed else None
    required_parts = _glibcxx_components(required)
    if observed_parts is None or required_parts is None:
        return False
    return observed_parts >= required_parts


def _glibcxx_ceiling(tokens: str) -> str:
    """Reduce every version the probe printed to the highest one.

    The probe deliberately does not sort (see `_GLIBCXX_CEILING_PROBE`), so the
    maximum is computed here, from the same numeric components the pass/fail
    decision uses. A lexicographic maximum is the bug this replaces: on a real
    libstdc++ the highest token by byte order is `GLIBCXX_3.4.9`, which is
    thirty-one releases short of a real ceiling and would refuse an image that
    in fact carries GLIBCXX_3.4.35.

    Unparseable lines are skipped rather than fatal — the probe's output is a
    container-controlled string, and one odd line must not turn the probe into
    an exception. A stream with no parseable version yields "", which every
    caller already reads as "not new enough".
    """
    best: tuple[int, ...] | None = None
    for line in tokens.splitlines():
        components = _glibcxx_components(line.strip())
        if components is not None and (best is None or components > best):
            best = components
    return f"GLIBCXX_{'.'.join(str(part) for part in best)}" if best else ""


def _describe_glibcxx(observed: str | None) -> str:
    return observed.strip() if observed and observed.strip() else "none found"


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
        await self._ensure_cpp_runtime(environment)
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
        # Read the trace dir while the container is still alive. It is the only
        # moment the question is answerable, and it is the question `results.json`
        # otherwise leaves open: the ask JSON carries no turn-by-turn record, so
        # a metadata dict that says only "a trace was requested" cannot tell a
        # retained trajectory from an absent one.
        trace_state = await self._probe_trace_dir(environment, options)
        # Only worth a second container round trip when the first one already
        # said a trajectory is there; an empty or absent dir has no file to
        # name, and a second probe there could only ever answer "nothing".
        trace_file = (
            await self._probe_trace_file(environment, options)
            if trace_state == _TRACE_PROBE_PRESENT
            else None
        )
        if _is_capped_turn_run(parsed, result.return_code):
            self.logger.warning(
                "iknow hit its turn budget; scoring the partial run instead of "
                "erroring the trial"
            )
            context.metadata = _run_metadata(
                parsed, options, trace_state, trace_file
            )
            return
        if result.return_code != 0:
            raise self._classify_exec_error(command, result)
        if parsed.kind == "none":
            raise NonZeroAgentExitCodeError(
                "iknow ask exited 0 but printed no JSON object. Output: "
                f"{self._truncate_output(result.stdout)}"
            )
        self._assert_run_state_named(parsed, options)
        _apply_to_context(parsed, context, options, trace_state, trace_file)

    async def _probe_trace_dir(
        self, environment: BaseEnvironment, options: IKnowOptions
    ) -> str | None:
        """Name what the trace dir actually holds: present / empty / absent.

        `None` when tracing was not requested — the third value is not a
        failure, it is the default, and conflating the two is the bug.

        The three states are the whole point. iknow's own warn-once notice
        covers a writer that *tried* and failed, but a run that never got far
        enough to write anything — a missing API key, a settings error, an
        addon that failed to load — leaves the directory empty and prints no
        notice at all, so a parse of the output stream cannot see it. Both of
        those are measured: a real `ask --trace-out` with no API key produced
        the provider envelope, exit 1, and a trace dir holding zero files.

        So the directory is read here, in the container, while it still exists.
        `test -s` (size > 0) rather than existence: a zero-byte `.jsonl` means
        the writer opened the file and the run then died, which is not a
        trajectory either, and a reader must not be handed it as one.
        """
        if not options.trace_out:
            return None
        result = await environment.exec(command=_trace_probe_command(_trace_out_dir()))
        observed = (result.stdout or "").strip()
        if observed not in (
            _TRACE_PROBE_PRESENT,
            _TRACE_PROBE_EMPTY,
            _TRACE_PROBE_ABSENT,
        ):
            # An unreadable probe is not a passing probe. Defaulting to the
            # pessimistic reading is what keeps the metadata from claiming a
            # trajectory the adapter did not confirm.
            self.logger.warning(
                "could not read the iknow trace directory %s (got %r); "
                "recording the trial as having no usable trace",
                _trace_out_dir(),
                observed,
            )
            return _TRACE_PROBE_ABSENT
        return observed

    async def _probe_trace_file(
        self, environment: BaseEnvironment, options: IKnowOptions
    ) -> str | None:
        """Name the trajectory file this run retained, if it retained one.

        The conversation id is minted by `iknow ask` inside the container and
        never printed, so without this the trial's `agent/trace/<id>.jsonl`
        could only be found by globbing. Reading it out here — while the
        container still exists, the same window `_probe_trace_dir` uses — is
        what lets a reviewer holding a `reward.txt` and a `result.json` name
        the exact run that produced them.

        Returns None when no trace was requested, none was retained, or the
        probe was unreadable. A name is never invented from the directory.
        """
        if not options.trace_out:
            return None
        result = await environment.exec(
            command=_trace_file_probe_command(_trace_out_dir())
        )
        name = (result.stdout or "").strip()
        if not name or "/" in name or not name.endswith(".jsonl"):
            # Defensive against a probe whose output is not a bare file name:
            # an unusable answer yields no id, never a malformed one.
            return None
        return f"{_trace_out_dir()}/{name}"

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

    async def _ensure_cpp_runtime(self, environment: BaseEnvironment) -> None:
        """Guarantee a libstdc++ that can provide `REQUIRED_GLIBCXX`.

        Runs before `_ensure_node` and before the bundle smoke test, because
        the failure it prevents only surfaces once node has executed the
        addon: a Debian 12 trial loaded node fine and then died in
        `_assert_bundle_runtime` with "version `GLIBCXX_3.4.31' not found".

        The version is *re-checked after* installing, never assumed from the
        install's exit code. That is the load-bearing part: on an image whose
        libstdc++ is already at the repository candidate (Debian 12 ships
        GLIBCXX_3.4.30), `apt-get install -y libstdc++6` prints "already the
        newest version", exits 0, and changes nothing. Treating that exit 0
        as success would hand back a container that fails the same way it
        entered, so the post-install probe is what decides.

        What is deliberately *not* attempted: pulling a newer libstdc++ from a
        foreign Debian suite. The one combination that clears 3.4.31 (trixie
        libstdc++6 14.2.0) drags in `libc-bin 2.41`, so "fixing" the addon
        would upgrade the image's glibc underneath a benchmark task that
        measures git behaviour. That is a larger change to the task
        environment than a benchmark adapter is entitled to make silently, so
        the image is refused with the ceiling named instead.
        """
        ceiling = await self._probe_glibcxx_ceiling(environment)
        if _glibcxx_at_least(ceiling, REQUIRED_GLIBCXX):
            self.logger.debug(
                "libstdc++ already provides %s (ceiling %s); no install issued",
                REQUIRED_GLIBCXX,
                _describe_glibcxx(ceiling),
            )
            return

        manager = await self._get_system_package_manager(environment)
        if manager is None:
            raise IKnowCppRuntimeTooOldError(
                f"the task image's libstdc++ provides at most "
                f"{_describe_glibcxx(ceiling)}, but iknow's tree-sitter "
                f"prebuild needs {REQUIRED_GLIBCXX}, and none of the supported "
                "package managers (apt-get, apk, dnf, yum) is present to "
                "install a newer one. Use a glibc task image with a GCC 12 or "
                "newer C++ runtime."
            )
        package, install, env = _cxx_runtime_install(manager)
        self.logger.info(
            "libstdc++ ceiling is %s, below the required %s; installing %s via %s",
            _describe_glibcxx(ceiling),
            REQUIRED_GLIBCXX,
            package,
            manager,
        )
        # The install is run through the *bare* environment.exec, not
        # exec_as_root, because exec_as_root raises on a non-zero exit and the
        # outcome has to be read rather than thrown:
        #
        #   - success (0): the post-install probe is still the authority, since
        #     "already the newest version" is also a 0 that changed nothing.
        #   - failure (non-zero): a stale apt cache ("Unable to locate
        #     package libstdc++6"), a dead registry, a full /var/cache — the
        #     install did not raise the ceiling, but that is a statement about
        #     *this attempt*, not about what the distribution has. Asserting
        #     "the distribution's own C++ runtime is the ceiling here" from a
        #     failed install would send the reader to change task image when
        #     the fix is a cache refresh, so the install's own output is
        #     reported instead.
        result = await environment.exec(
            command=f"set -o pipefail; {install} {package}",
            user="root",
            env=env,
        )
        install_error = None
        if result.return_code != 0:
            install_error = (
                f"(exit {result.return_code}) "
                f"{self._truncate_output(result.stderr or result.stdout)}"
            )
            self.logger.info(
                "installing %s via %s failed: %s", package, manager, install_error
            )

        upgraded = await self._probe_glibcxx_ceiling(environment)
        if not _glibcxx_at_least(upgraded, REQUIRED_GLIBCXX):
            if install_error is not None:
                # The install failed, so "the install did not raise the
                # ceiling" is all that has been established; the repository may
                # still hold a new enough build.
                raise IKnowCppRuntimeTooOldError(
                    f"the task image's libstdc++ provides at most "
                    f"{_describe_glibcxx(upgraded)}, still short of the "
                    f"{REQUIRED_GLIBCXX} iknow's tree-sitter prebuild needs "
                    f"(measured from the bundle: _ZNSt7__cxx1112basic_stringI"
                    "cSt11char_traitsIcESaIcEE15_M_replace_cold...@"
                    f"{REQUIRED_GLIBCXX}), and `installing {package} via "
                    f"{manager}` did not raise the ceiling: {install_error}. "
                    "This is the install failing, not a statement that the "
                    "distribution has nothing newer: check the image's package "
                    "cache and repository reachability first (an `apt-get "
                    "update` that cannot reach the mirrors, an unreachable "
                    "registry, a full /var/cache all look like this), and only "
                    "then whether the image needs a newer C++ runtime."
                )
            raise IKnowCppRuntimeTooOldError(
                f"the task image's libstdc++ still provides at most "
                f"{_describe_glibcxx(upgraded)} after installing {package} via "
                f"{manager}, but iknow's tree-sitter prebuild needs "
                f"{REQUIRED_GLIBCXX} (measured from the bundle: "
                "_ZNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEE15_"
                "_M_replace_cold...@GLIBCXX_3.4.31). The distribution's own "
                "C++ runtime is the ceiling here, so this image cannot host "
                "the shipped prebuild; use a task image with a GCC 12+ "
                "toolchain (Debian 13/Ubuntu 24.04 or newer, RHEL 9+)."
            )
        self.logger.info(
            "libstdc++ ceiling after installing %s: %s", package, upgraded
        )

    async def _probe_glibcxx_ceiling(self, environment: BaseEnvironment) -> str:
        """Read the highest `GLIBCXX_` version the image's libstdc++ defines.

        The shell emits every match and Python picks the maximum numerically;
        see `_glibcxx_ceiling`. Returns the empty string when no readable
        libstdc++.so.6 is found, and the caller treats that as "not new enough"
        — an image where the runtime is missing entirely is strictly worse than
        one where it is old, so it must reach the install attempt and its own
        error.
        """
        result = await self.exec_as_root(
            environment, command=_GLIBCXX_CEILING_PROBE
        )
        return _glibcxx_ceiling(result.stdout or "")

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
        # The trace dir is created here rather than left to iknow's own
        # deferred `mkdirSync` (src/harness/trace/jsonl.ts:222): that mkdir is
        # inside a writer that is only reached on the *first* record, and the
        # writer is swapped out wholesale by anything that injects its own, so
        # an adapter that relied on it would be relying on a detail two layers
        # down. The parent already exists either way, since `tee` needs it.
        dirs = [log_dir]
        trace_out = ""
        if options.trace_out:
            dirs.append(_trace_out_dir())
            trace_out = f" {TRACE_OUT_FLAG} {shlex.quote(_trace_out_dir())}"
        return (
            "set -o pipefail; "
            f"mkdir -p {' '.join(shlex.quote(d) for d in dirs)} && "
            f"cd {self._install_dir(home)} && "
            f"node ./dist/cli.js ask {shlex.quote(instruction)} --json{eval_state}"
            f"{max_turns}{trace_out} 2>&1 </dev/null | tee "
            f"{shlex.quote(log_dir)}/{_OUTPUT_FILENAME}"
        )


def _trace_probe_command(directory: str) -> str:
    """The post-run probe: name what the trace dir holds, in one word.

    A parameter, not a hardcoded path, so a test can point the very same command
    at a fixture directory and run it in a real shell — the empty case is a
    filesystem state, and a stubbed `exec` asserts the string, not the state.

    POSIX sh only, and `-s` rather than `-e`, on purpose:

    - An unmatched glob expands to itself *literally* (`sh -c 'set -- /no/*.jsonl'`
      yields `/no/*.jsonl`), so "the dir exists but holds no trace" needs no
      `[ -e "$f" ]` guard and cannot be read as a file. The glob is outside the
      quotes and the path inside, which is what keeps a directory with a space
      in its name working.
    - `-s` is size > 0, so a zero-byte `.jsonl` — the writer opened the file
      and the run then died — is not counted as a retained trajectory.
    """
    quoted = shlex.quote(directory)
    return (
        f"for f in {quoted}/*.jsonl; do "
        f'if [ -s "$f" ]; then echo {_TRACE_PROBE_PRESENT}; exit 0; fi; '
        f"done; "
        f'if [ -d {quoted} ]; then echo {_TRACE_PROBE_EMPTY}; '
        f"else echo {_TRACE_PROBE_ABSENT}; fi"
    )


def _trace_file_probe_command(directory: str) -> str:
    """Print the first non-empty trace file name in *directory*, or nothing.

    POSIX sh only, and `-s` for the same reason `_trace_probe_command` uses
    it: a zero-byte `.jsonl` is a writer that opened the file and a run that
    then died, which is not a trajectory and must not be named as one. The
    name is printed bare (no directory prefix) because the trial metadata
    already carries the directory as `trace_out`; repeating it would let the
    two disagree.
    """
    quoted = shlex.quote(directory)
    return (
        f"for f in {quoted}/*.jsonl; do "
        f'if [ -s "$f" ]; then printf "%s\\n" "${{f##*/}}"; exit 0; fi; '
        "done"
    )


def _trace_out_dir() -> str:
    """The container path `--trace-out` is handed, as a *directory*.

    Inside the agent log dir rather than a harbor artifact entry, and the two
    facts that decide that:

    - The log dir is already mounted from the trial directory and already
      collected, whole, by `_download_agent_logs` (trial.py:573-593) — no
      `artifacts:` config, and no separate `download_dir` round trip, is needed
      for a file the agent itself writes. A `--artifact` entry would buy a
      manifest row and a flat `artifacts/logs/agent/trace/` mirror of the very
      same bytes.
    - `/logs/artifacts/` is reserved for artifacts re-materialized into a
      *separate* verifier environment (`ArtifactHandler.upload_artifacts`,
      artifact_handler.py:169-214), and this trace is evidence for reading the
      agent's run, not an input to the verifier.

    Harbor's `include_logs` / `exclude_logs` (trial.py:603-609, the dispatch
    inside `_download_role_logs`) therefore govern it like every other agent
    log, with no extra configuration.

    One definition, not two: the command and the trial metadata must name the
    same path, and a reader of `results.json` compares the two.
    """
    return f"{EnvironmentPaths.agent_dir.as_posix()}/{_TRACE_DIRNAME}"


def _is_capped_turn_run(parsed: ParsedRun, return_code: int) -> bool:
    return (
        return_code != 0
        and parsed.kind == "error_envelope"
        and parsed.error_code == _MAX_TURNS_ERROR
    )


def _run_metadata(
    parsed: ParsedRun,
    options: IKnowOptions,
    trace_state: str | None = None,
    trace_file: str | None = None,
) -> dict[str, Any]:
    # ADR-0130 reporting invariant: an eval-state number must name its state, so
    # the posture lands on the trial record, not only in the launch command.
    metadata: dict[str, Any] = {
        "permission_mode": options.permission_mode,
        "eval_state": options.eval_state,
    }
    if options.trace_out:
        # The *directory* the trial asked for, not a file: `--trace-out` writes
        # `<dir>/<conversationId>.jsonl` and the conversation id is a random
        # UUID minted inside the container, so naming a file here would assert
        # a path the adapter never saw. Recorded so a reader of `results.json`
        # can tell "no trace was retained" from "the trace was never requested".
        metadata["trace_out"] = _trace_out_dir()
        # What actually landed, read out of the container before it was torn
        # down. The three states are the point: a run that never wrote a record
        # (no API key, a settings error, an addon that would not load) produces
        # no notice on the output stream, so without this key `trace_out` reads
        # as "a trajectory is here" for a trial that has none.
        metadata["trace_state"] = trace_state or _TRACE_PROBE_ABSENT
    if trace_file is not None:
        # The concrete file this trial retained, and the conversation id it
        # carries. This is the join key between a trajectory and the grader
        # result beside it: `results.json` names this path, and a reader can
        # open exactly the run that produced the adjacent `reward.txt`.
        # Recorded only when a file was actually observed — never derived from
        # the directory alone, which would name a trajectory that does not
        # exist.
        metadata["trace_file"] = trace_file
        metadata["trace_conversation_id"] = trace_file.rsplit("/", 1)[-1][: -len(".jsonl")]
    if parsed.trace_write_failed:
        # A trace that could not be written is not an error the trial failed
        # for — iknow warns once and answers anyway, and the answer is still
        # scoreable. It does mean the trajectory this trial was launched to
        # retain is absent, which must not be read as "nothing went wrong".
        metadata["trace_write_failed"] = True
    if parsed.error_code is not None:
        metadata["iknow_error"] = parsed.error_code
    if parsed.turn_count is not None:
        metadata["turn_count"] = parsed.turn_count
    return metadata


def _apply_to_context(
    parsed: ParsedRun,
    context: AgentContext,
    options: IKnowOptions,
    trace_state: str | None = None,
    trace_file: str | None = None,
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
    metadata = _run_metadata(parsed, options, trace_state, trace_file)
    if parsed.stop_reason is not None:
        metadata["stop_reason"] = parsed.stop_reason
    context.metadata = metadata


def _env_value(env: Mapping[str, str] | None, key: str) -> str | None:
    value = (env or {}).get(key)
    return value or os.environ.get(key) or None
