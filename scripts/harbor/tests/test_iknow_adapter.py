import asyncio
import json
import os
import shlex
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest
from harbor.agents.installed.base import (
    AgentAuthenticationError,
    ApiRateLimitError,
    ModelNotFoundError,
    NonZeroAgentExitCodeError,
)
from harbor.agents.options import Env

from iknow_harbor import IKnowAgent
from iknow_harbor import agent as agent_module
from iknow_harbor.agent import (
    _CXX_RUNTIME_INSTALLS,
    _GLIBCXX_CEILING_PROBE,
    _MAX_TURNS_ERROR,
    _NODE_MARKER,
    _TRACE_DIRNAME,
    _TRACE_PROBE_ABSENT,
    _TRACE_PROBE_EMPTY,
    _TRACE_PROBE_PRESENT,
    EVAL_STATE_ENV,
    EVAL_STATE_FLAG,
    EVAL_STATE_RUN_LABEL,
    MINIMAX_API_KEY_ENV,
    PERMISSION_MODE_ENV,
    REQUIRED_GLIBCXX,
    TRACE_OUT_ENV,
    TRACE_OUT_FLAG,
    IKnowCppRuntimeTooOldError,
    IKnowEvalStateUnsupportedError,
    IKnowGlibcRequiredError,
    IKnowInstallError,
    IKnowNodeUnavailableError,
    IKnowOptions,
    IKnowRunStateMismatchError,
    _cxx_runtime_install,
    _glibcxx_at_least,
    _glibcxx_ceiling,
    _glibcxx_probe_command,
    _run_metadata,
    _trace_probe_command,
    render_iknow_settings,
)
from iknow_harbor.ask_output import ParsedRun, parse_iknow_ask_output

MODEL_ROUTE = "minimax-cn/MiniMax-M3.1-Flash-Preview"

# Verbatim ask output observed on the host: iknow's typed config envelope
# (src/config/env.ts) and the live 401 reply from the MiniMax endpoint.
API_KEY_ENVELOPE = (
    '{"error":"llm_provider_api_key_missing","code":"provider_api_key_missing",'
    '"provider":"minimax-cn","apiKeyEnv":"MINIMAX_API_KEY","message":'
    '"provider_api_key_missing: minimax-cn (env MINIMAX_API_KEY unset)"}'
)
ENDPOINT_401 = (
    '{"error":"error","message":"401 {\\"type\\":\\"error\\",\\"error\\":'
    '{\\"type\\":\\"authentication_error\\",\\"message\\":\\"login fail: Please '
    'carry the API secret key in the \'X-Api-Key\' field of the request '
    'header\\"},\\"request_id\\":\\"0709\\"}"}'
)


def agent(tmp_path) -> IKnowAgent:
    return IKnowAgent(
        logs_dir=tmp_path,
        model_name=MODEL_ROUTE,
        bundle_path="/tmp/iknow-bundle.tgz",
    )


def classify(tmp_path, output: str, return_code: int = 1) -> type[Exception]:
    result = SimpleNamespace(return_code=return_code, stdout=output, stderr="")
    return type(agent(tmp_path)._classify_exec_error("iknow ask", result))


class TestProviderErrorTaxonomy:
    @pytest.mark.parametrize(
        ("output", "expected"),
        [
            (API_KEY_ENVELOPE, AgentAuthenticationError),
            (ENDPOINT_401, AgentAuthenticationError),
            (
                "provider_model_not_registered: MiniMax-X (not in llm.providers)",
                ModelNotFoundError,
            ),
            ("Rate limit reached for MiniMax-M3.1", ApiRateLimitError),
            ("错误: 429 rate_limit_error", ApiRateLimitError),
            ("Error: 429 Too Many Requests", ApiRateLimitError),
            ("nothing recognised here", NonZeroAgentExitCodeError),
        ],
    )
    def test_iknow_messages_land_on_harbor_error_classes(
        self, tmp_path, output: str, expected: type[Exception]
    ):
        assert classify(tmp_path, output) is expected


class TestSettingsTemplate:
    def test_route_is_split_into_the_provider_registry_block(self):
        settings = json.loads(render_iknow_settings(MODEL_ROUTE))

        llm = settings["llm"]
        assert llm["model"] == MODEL_ROUTE
        provider = llm["providers"][0]
        assert provider["id"] == "minimax-cn"
        assert provider["apiKeyEnv"] == "MINIMAX_API_KEY"
        assert provider["models"][0]["id"] == "MiniMax-M3.1-Flash-Preview"
        assert "apiKey" not in llm

    @pytest.mark.parametrize(
        "route", ["", "no-slash", "minimax-cn/", "/MiniMax-M3", "other/MiniMax-M3"]
    )
    def test_unusable_routes_are_rejected(self, route: str):
        with pytest.raises(ValueError):
            render_iknow_settings(route)


class TestAgentSurface:
    def test_name_and_import_path_are_addressable(self):
        assert IKnowAgent.name() == "iknow"
        assert IKnowAgent.import_path() == "iknow_harbor.agent:IKnowAgent"

    def test_options_are_validated_before_any_container_starts(self, tmp_path):
        with pytest.raises(ValueError, match="plan"):
            IKnowAgent.parse_options({"permission_mode": "yolo"})

    def test_preflight_reports_a_missing_bundle(self, tmp_path):
        with pytest.raises(ValueError, match="build-bundle.sh"):
            IKnowAgent.preflight(
                kwargs={"bundle_path": str(tmp_path / "absent.tgz")}, env={}
            )

    def test_preflight_reports_a_missing_api_key(self, tmp_path, monkeypatch):
        # preflight falls back to the host process env (harbor forwards the key
        # from there), so the test has to clear it to mean "absent".
        monkeypatch.delenv("MINIMAX_API_KEY", raising=False)

        with pytest.raises(ValueError, match="MINIMAX_API_KEY is not set"):
            IKnowAgent.preflight(
                kwargs={"bundle_path": "/tmp/iknow-bundle.tgz"},
                env={"MINIMAX_API_KEY": ""},
            )

    def test_a_foreign_model_route_fails_before_the_container_works(self, tmp_path):
        subject = IKnowAgent(
            logs_dir=tmp_path,
            model_name="anthropic/claude-sonnet-4-5",
            bundle_path="/tmp/iknow-bundle.tgz",
        )

        with pytest.raises(ValueError, match="minimax-cn"):
            subject._settings_text()

    def test_ask_command_pins_permission_mode_and_the_json_flag(self, tmp_path):
        subject = agent(tmp_path)
        options = subject.options

        command = subject._ask_command(
            "write 'a b' to /app/out.txt", options, home="/root"
        )

        assert "set -o pipefail" in command
        assert "ask 'write '\"'\"'a b'\"'\"' to /app/out.txt' --json" in command
        assert "tee /logs/agent/iknow-ask.txt" in command

    def test_ask_command_adds_max_turns_only_when_configured(self, tmp_path):
        subject = IKnowAgent(
            logs_dir=tmp_path,
            model_name="minimax-cn/MiniMax-M3.1-Flash-Preview",
            bundle_path="/tmp/iknow-bundle.tgz",
            max_turns=12,
        )

        command = subject._ask_command("q", subject.options, home="/root")

        assert "--max-turns 12" in command


class _StubEnvironment:
    """Minimal BaseEnvironment stand-in: records the command, replays a result."""

    def __init__(self, stdout: str = "", return_code: int = 0):
        self._stdout = stdout
        self._return_code = return_code
        self.commands: list[str] = []

    async def exec(self, command: str, **_ignored):
        self.commands.append(command)
        return SimpleNamespace(
            return_code=self._return_code, stdout=self._stdout, stderr=""
        )


class _NodePathEnvironment(_StubEnvironment):
    """Replays results keyed by a substring of the command, not by call index.

    Lets one stub stand for a whole install path: an nvm tree the fresh shell
    cannot see, the symlink that fixes it, and the probe that proves it.
    Keying on content is what makes these tests assert the contract — an
    adapter that emitted the same commands in a different order, or skipped
    one, fails here instead of replaying the wrong result into the next step.

    A needle may map to a list of results consumed in order, because the
    adapter issues two textually identical `node -e <floor probe>` commands
    (one before the link, one after) that must answer differently; the last
    entry repeats. The first matching needle wins, so a more specific needle
    belongs earlier in the mapping.

    It is a real `BaseEnvironment` subclass, not a bare stand-in, because
    harbor's `_exec` reaches through the real object (`_redact_command`,
    `_truncate_output`, `_classify_exec_error`) and a `Mock()` would answer
    those with truthy Mock objects. Only `exec` / `upload_file` are overridden;
    the real `default_user` stays None, which is what makes the upload helpers
    skip their chown/chmod legs.
    """

    default_user = None

    def __init__(self, results, default=("", "", 0)):
        super().__init__()
        self._results = {
            needle: (list(value) if isinstance(value, list) else [value])
            for needle, value in results.items()
        }
        self._default = default
        self.users: list[str | None] = []
        self.envs: list[dict | None] = []
        self.uploads: list[tuple[str, str]] = []

    async def exec(self, command: str, user=None, env=None, **_ignored):
        self.commands.append(command)
        self.users.append(user)
        self.envs.append(env)
        for needle, replay in self._results.items():
            if needle in command:
                stdout, stderr, return_code = (
                    replay.pop(0) if len(replay) > 1 else replay[0]
                )
                return SimpleNamespace(
                    return_code=return_code, stdout=stdout, stderr=stderr
                )
        stdout, stderr, return_code = self._default
        return SimpleNamespace(return_code=return_code, stdout=stdout, stderr=stderr)

    async def upload_file(self, source_path, target_path):
        self.uploads.append((str(source_path), str(target_path)))


def _calls(environment: _StubEnvironment, needle: str) -> list[str]:
    return [command for command in environment.commands if needle in command]


def _first_command(environment: _NodePathEnvironment, needle: str) -> int:
    """Where a needle first appears in the command stream, or a hard failure.

    A missing needle has to fail the test rather than answer -1, which would
    silently compare against the tail of an unrelated command. Substring, not
    regex: `list.index` is an exact comparison, and a needle like
    `GLIBCXX_[0-9.]+` is a pattern, not a literal command.
    """
    matches = [index for index, command in enumerate(environment.commands) if needle in command]
    assert matches, (
        f"no command carried {needle!r}; the stub replayed the wrong result "
        f"into the step under test. Commands: {environment.commands}"
    )
    return matches[0]


# The adapter's ceiling probe, the package-manager sniff, and the install
# command. Kept as module constants so a test asserts on the exact needles the
# stub dispatches on: if the adapter renames its probe, these tests fail to
# find their needles and replay the default result, which is a test failure
# rather than a silently-passing one.
_CEILING_NEEDLE = "GLIBCXX_[0-9.]+"
_MANAGER_NEEDLE = "for manager in apt-get dnf yum apk"
_INSTALL_NEEDLES = ("install -y", "apk add --no-cache")

def _run_probe(candidates) -> subprocess.CompletedProcess:
    """Run a probe command the way harbor runs it: `bash -c`, `set -o pipefail`."""
    return subprocess.run(
        ["bash", "-c", f"set -o pipefail; {_glibcxx_probe_command(candidates)}"],
        capture_output=True,
        text=True,
        # The exit code is the thing under test, not an accident to raise on.
        check=False,
    )


def _run_trace_probe(probe: str, trace_dir: Path) -> str:
    """Run the trace probe against a real directory and return its one word."""
    result = subprocess.run(
        ["bash", "-c", f"set -o pipefail; {probe}"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, (
        f"the trace probe must exit 0 whatever the directory holds; got "
        f"{result.returncode}: {result.stderr}"
    )
    return result.stdout.strip()


# The verdict a real shell produces for the adapter's production probe on the
# *host*: the host happens to carry a real libstdc++.so.6 at one of the probed
# paths, so this is the "image has a runtime" case, and it is asserted on its
# exit code only. The "no readable libstdc++.so.6" case is modelled below
# against a path that cannot exist, so neither assertion depends on which
# libraries the machine running the suite happens to have.
_HOST_VERDICT = _run_probe(
    (
        "/usr/lib/x86_64-linux-gnu/libstdc++.so.6",
        "/usr/lib64/libstdc++.so.6",
        "/usr/lib/libstdc++.so.6",
        "/lib/x86_64-linux-gnu/libstdc++.so.6",
    )
)
assert _HOST_VERDICT.returncode == 0, (
    f"the production probe must exit 0 whatever the image holds; got "
    f"{_HOST_VERDICT.returncode}: {_HOST_VERDICT.stderr}"
)

# The image state the guard exists for: no readable libstdc++.so.6 anywhere.
# `grep` matches nothing, so without the `|| true` inside the loop every
# element of the pipeline exits 1 and harbor's `set -o pipefail` prefix turns
# that into a non-zero command — aborting install() with
# NonZeroAgentExitCodeError on precisely the image that most needs the install.
# Same builder as the production probe, so the guard under test is the same
# text; only the candidate path differs.
_NO_LIBSTDCXX_VERDICT = _run_probe((str(Path("/nonexistent/libstdc++.so.6")),))
assert _NO_LIBSTDCXX_VERDICT.returncode == 0, (
    "the probe must exit 0 on an image with no readable libstdc++.so.6; got "
    f"{_NO_LIBSTDCXX_VERDICT.returncode}: {_NO_LIBSTDCXX_VERDICT.stderr}"
)
assert _NO_LIBSTDCXX_VERDICT.stdout.strip() == ""


def _cpp_runtime_environment(ceiling, after=None, manager="apt-get", install=None):
    """A stub standing for the whole C++-runtime step.

    The ceiling is replayed as a two-entry list because the probe runs twice —
    once to decide whether an install is needed, once to check whether the
    install achieved anything. `after` defaults to the unchanged `ceiling`,
    which is exactly the Debian 12 case: `apt-get install -y libstdc++6`
    reports "already the newest version", exits 0, and leaves GLIBCXX_3.4.30
    in place. Replaying the *old* ceiling as the post-install answer is what
    makes the "install ran but nothing changed" test meaningful.

    The ceiling is fed back as a *stream* of version tokens rather than as
    one pre-picked string, because that is what the shell really prints: the
    probe emits every match and Python picks the maximum. A stub that answered
    a single line could not tell a probe that sorts by version from one that
    does not.

    `install` defaults to a successful install and takes an explicit
    (stderr, return_code) to model a failing one — an image whose apt cache is
    stale, whose registry is unreachable, or whose /var/cache is full. Those
    are different image states with different remedies, and they need different
    messages, so the stub has to be able to tell them apart.
    """

    def _install_result(success_stderr: str) -> tuple[str, str, int]:
        if install is None:
            return ("", success_stderr, 0)
        return ("", install[0], install[1])

    post = ceiling if after is None else after
    return _NodePathEnvironment(
        {
            _CEILING_NEEDLE: [
                (_glibcxx_stream(ceiling), "", 0),
                (_glibcxx_stream(post), "", 0),
            ],
            _MANAGER_NEEDLE: (manager, "", 0),
            "install -y": _install_result("Setting up libstdc++6"),
            "apk add": _install_result("OK: installed"),
        }
    )


# The tokens a real libstdc++ carries, in the order grep emits them. `3.4.9` is
# not a typo: it is the last token libstdc++ has carried for a very long time,
# so on any real library it is also the *lexicographic* maximum — the exact
# fact that makes a `sort -u -V | tail -1` and a plain `sort -u | tail -1`
# disagree, and that makes a stub answering one line unable to tell them apart.
_LIBSTDCXX_TOKENS = (
    "GLIBCXX_3.4",
    "GLIBCXX_3.4.0",
    "GLIBCXX_3.4.4",
    "GLIBCXX_3.4.9",
    "GLIBCXX_3.4.11",
    "GLIBCXX_3.4.19",
    "GLIBCXX_3.4.21",
    "GLIBCXX_3.4.24",
    "GLIBCXX_3.4.25",
    "GLIBCXX_3.4.26",
    "GLIBCXX_3.4.27",
    "GLIBCXX_3.4.28",
    "GLIBCXX_3.4.29",
    "GLIBCXX_3.4.30",
)


def _glibcxx_stream(ceiling: str) -> str:
    """The probe's output for a library whose highest token is `ceiling`."""
    if not ceiling:
        return ""
    wanted = tuple(int(part) for part in ceiling.removeprefix("GLIBCXX_").split("."))
    tokens = list(_LIBSTDCXX_TOKENS)
    if wanted > tuple(
        int(part) for part in tokens[-1].removeprefix("GLIBCXX_").split(".")
    ):
        tokens.append(ceiling)
    else:
        tokens = [token for token in tokens if _token_parts(token) <= wanted]
        tokens.append(ceiling)
    return "\n".join(tokens) + "\n"


def _token_parts(token: str) -> tuple[int, ...]:
    return tuple(int(part) for part in token.removeprefix("GLIBCXX_").split("."))


class TestCppRuntime:
    """The shipped prebuilds need GLIBCXX_3.4.31; the image must be able to give it."""

    def test_a_new_enough_runtime_issues_no_install(self, tmp_path):
        environment = _cpp_runtime_environment("GLIBCXX_3.4.33")
        subject = agent(tmp_path)

        asyncio.run(subject._ensure_cpp_runtime(environment))

        assert not any(
            needle in command
            for command in environment.commands
            for needle in _INSTALL_NEEDLES
        )
        # The sniff is skipped too: nothing needs installing, so there is no
        # reason to ask the image what package manager it has.
        assert not _calls(environment, _MANAGER_NEEDLE)

    def test_a_too_old_runtime_installs_the_distro_package(self, tmp_path):
        environment = _cpp_runtime_environment(
            "GLIBCXX_3.4.30", after="GLIBCXX_3.4.33"
        )
        subject = agent(tmp_path)

        asyncio.run(subject._ensure_cpp_runtime(environment))

        installs = _calls(environment, "libstdc++6")
        assert len(installs) == 1
        assert "apt-get install -y" in installs[0]
        # The install has to be root: it writes /usr/lib/x86_64-linux-gnu.
        install_index = environment.commands.index(installs[0])
        assert environment.users[install_index] == "root"
        # And the ceiling has to be re-read afterwards, not inferred from the
        # install's exit code.
        assert len(_calls(environment, _CEILING_NEEDLE)) == 2

    def test_the_apt_install_refreshes_the_cache_and_answers_debconf(
        self, tmp_path
    ):
        # `apt-get install` with no preceding `apt-get update` fails outright on
        # an image whose package cache is empty or stale — "Unable to locate
        # package libstdc++6" — and the repository may well have had a new
        # enough build all along. DEBIAN_FRONTEND is here for the same reason
        # harbor's own installer sets it: an unanswered debconf prompt hangs a
        # container with no pty rather than failing it. Both travel as the
        # per-exec env of the install, not as an inline assignment, because
        # the exec `env=` is the only form harbor forwards.
        environment = _cpp_runtime_environment(
            "GLIBCXX_3.4.30", after="GLIBCXX_3.4.33"
        )
        subject = agent(tmp_path)

        asyncio.run(subject._ensure_cpp_runtime(environment))

        installs = _calls(environment, "libstdc++6")
        assert len(installs) == 1
        assert "apt-get update && apt-get install" in installs[0]
        install_index = environment.commands.index(installs[0])
        assert environment.envs[install_index] == {
            "DEBIAN_FRONTEND": "noninteractive"
        }

    @pytest.mark.parametrize(
        ("manager", "package", "install_fragment"),
        [
            ("apk", "libstdc++", "apk add --no-cache"),
            ("dnf", "libstdc++", "dnf install -y"),
            ("yum", "libstdc++", "yum install -y"),
        ],
    )
    def test_non_debian_families_get_their_own_package_name(
        self, tmp_path, manager, package, install_fragment
    ):
        environment = _cpp_runtime_environment(
            "GLIBCXX_3.4.29", after="GLIBCXX_3.4.32", manager=manager
        )
        subject = agent(tmp_path)

        asyncio.run(subject._ensure_cpp_runtime(environment))

        installs = _calls(environment, install_fragment)
        assert len(installs) == 1
        # `libstdc++6` is the Debian soname spelling; asking apk/dnf/yum for it
        # resolves to nothing, and apk would also need the index refreshed.
        assert "libstdc++6" not in installs[0]
        assert installs[0].endswith(f"{install_fragment} {package}")

    def test_an_image_with_no_package_manager_says_so(self, tmp_path):
        environment = _cpp_runtime_environment("GLIBCXX_3.4.30", manager="")
        subject = agent(tmp_path)

        with pytest.raises(IKnowCppRuntimeTooOldError) as excinfo:
            asyncio.run(subject._ensure_cpp_runtime(environment))

        message = str(excinfo.value)
        # Both halves of the fact: what the image has, and what it needs.
        assert "GLIBCXX_3.4.30" in message
        assert REQUIRED_GLIBCXX in message
        assert "apt-get, apk, dnf, yum" in message
        assert not any(
            needle in command
            for command in environment.commands
            for needle in _INSTALL_NEEDLES
        )

    def test_an_install_that_changes_nothing_raises_rather_than_continues(
        self, tmp_path
    ):
        # The real Debian 12 trial image: the package is already at the
        # repository candidate, so the install exits 0 having done nothing and
        # the ceiling is unchanged. Continuing here would reach the smoke test
        # and fail there with a dlopen message, so the ceiling is named here.
        environment = _cpp_runtime_environment("GLIBCXX_3.4.30", after="GLIBCXX_3.4.30")
        subject = agent(tmp_path)

        with pytest.raises(IKnowCppRuntimeTooOldError) as excinfo:
            asyncio.run(subject._ensure_cpp_runtime(environment))

        message = str(excinfo.value)
        assert "GLIBCXX_3.4.30" in message
        assert "libstdc++6" in message
        assert "apt-get" in message
        assert REQUIRED_GLIBCXX in message
        # It is not a glibc-family rejection: this image's libc is fine, its
        # C++ runtime is old, and the two have different remedies.
        assert not isinstance(excinfo.value, IKnowGlibcRequiredError)
        # The install really was attempted before the refusal.
        assert _calls(environment, "libstdc++6")
        # A *successful* install that moved nothing is the case where the
        # distribution is the ceiling, and the message says exactly that.
        assert "distribution's own C++ runtime is the ceiling" in message

    def test_a_failing_install_is_reported_as_a_failed_install_not_a_ceiling(
        self, tmp_path
    ):
        # A stale apt cache, an unreachable registry, a full /var/cache: the
        # install fails and the ceiling does not move. Asserting "the
        # distribution's own C++ runtime is the ceiling" here would send the
        # reader to change task image when the repository may hold a new enough
        # build, so the error has to name the install's own failure instead —
        # and still report the exit code and the manager's stderr, which is
        # what tells the two cases apart.
        environment = _cpp_runtime_environment(
            "GLIBCXX_3.4.30",
            after="GLIBCXX_3.4.30",
            install=("E: Unable to locate package libstdc++6", 100),
        )
        subject = agent(tmp_path)

        with pytest.raises(IKnowCppRuntimeTooOldError) as excinfo:
            asyncio.run(subject._ensure_cpp_runtime(environment))

        message = str(excinfo.value)
        assert "GLIBCXX_3.4.30" in message
        assert REQUIRED_GLIBCXX in message
        assert "Unable to locate package libstdc++6" in message
        assert "exit 100" in message
        # The reader's next step differs completely between the two states, so
        # the distribution-ceiling verdict must NOT be asserted from a failed
        # install.
        assert "distribution's own C++ runtime is the ceiling" not in message
        # And the post-install probe still runs, so the reported ceiling is a
        # fact about the container rather than an inference from the failure.
        assert len(_calls(environment, _CEILING_NEEDLE)) == 2

    def test_a_missing_libstdcxx_is_treated_as_too_old_not_as_new_enough(
        self, tmp_path
    ):
        # The probe prints nothing when no readable libstdc++.so.6 exists.
        # An empty string must never compare as "good enough", or an image
        # with no C++ runtime at all would skip the install and fail later.
        environment = _cpp_runtime_environment(
            "", after="", manager="apt-get"
        )
        subject = agent(tmp_path)

        with pytest.raises(IKnowCppRuntimeTooOldError) as excinfo:
            asyncio.run(subject._ensure_cpp_runtime(environment))

        assert "none found" in str(excinfo.value)
        assert _calls(environment, "libstdc++6")


class TestInstallOrdering:
    """install() pins its own step order; nothing below drives the step directly."""

    def _environment(self, ceiling: str, install=("", "Setting up libstdc++6", 0)):
        """A stub that answers every probe install() issues, in any order.

        `ceiling` is the post-install answer, so the C++-runtime step is never a
        no-op: a step that returned early would make the order untestable. The
        first probe therefore always reports the Debian 12 ceiling, whatever
        the caller asks the post-install one to be.
        """
        environment = _NodePathEnvironment(
            {
                'printf %s "$HOME"': ("/root", "", 0),
                "ldd --version": ("ldd (Debian 12) 2.36", "", 0),
                _CEILING_NEEDLE: [
                    (_glibcxx_stream("GLIBCXX_3.4.30"), "", 0),
                    (_glibcxx_stream(ceiling), "", 0),
                ],
                _MANAGER_NEEDLE: ("apt-get", "", 0),
                "install -y": install,
                "process.versions.node": ("v22.23.3", "", 0),
                "tar xzf": ("", "", 0),
                _NODE_MARKER: (f"{_NODE_MARKER}\niknow-native-ok", "", 0),
                "--help": ("  --eval-state  posture", "", 0),
            }
        )
        environment.exec_as_root = _pass_through_root_exec(environment)
        return environment

    def _agent(self, tmp_path, bundle: Path) -> IKnowAgent:
        subject = IKnowAgent(
            logs_dir=tmp_path,
            model_name=MODEL_ROUTE,
            bundle_path=str(bundle),
        )
        subject.ensure_system_dependencies = _no_op
        return subject

    def test_the_cpp_runtime_is_checked_before_node_and_before_the_smoke_test(
        self, tmp_path
    ):
        # Ordering is the behaviour: the C++ runtime is checked before node is
        # installed and before the bundle smoke test, so an image that cannot
        # satisfy it is refused as a runtime problem rather than surfacing
        # later as a native-addon load failure attributed to glibc. Driving
        # install() is what makes this the adapter's own order and not the test
        # choosing it: deleting the call, or moving it after `_ensure_node`,
        # leaves this failing on the recorded sequence.
        bundle = tmp_path / "bundle.tgz"
        bundle.write_bytes(b"not really a tarball")
        environment = self._environment("GLIBCXX_3.4.33")
        subject = self._agent(tmp_path, bundle)

        asyncio.run(subject.install(environment))

        issued = environment.commands
        assert issued, "install() must actually drive the container"
        # `_CEILING_NEEDLE` is a regular expression, so it has to be matched,
        # not compared: the probe command that carries it is the whole
        # recorded entry, not the needle.
        cpp_step = _first_command(environment, _CEILING_NEEDLE)
        node_step = _first_command(environment, "process.versions.node")
        smoke_step = _first_command(environment, _NODE_MARKER)
        assert cpp_step < node_step < smoke_step

    def test_a_failing_install_stops_the_install_before_the_bundle_is_unpacked(
        self, tmp_path
    ):
        # The other half of the ordering claim, and the reason the first one
        # could pass by accident: a step that raises early would never reach
        # the smoke test, so a reordering behind `_ensure_node` would be
        # invisible there. Driving install() over an image whose install fails
        # pins the refusal to the earliest point: nothing is uploaded, nothing
        # is unpacked, and the message reports the install's own failure.
        bundle = tmp_path / "bundle.tgz"
        bundle.write_bytes(b"not really a tarball")
        environment = self._environment(
            "GLIBCXX_3.4.30",
            install=("", "E: Unable to locate package libstdc++6", 100),
        )
        subject = self._agent(tmp_path, bundle)

        with pytest.raises(IKnowCppRuntimeTooOldError) as excinfo:
            asyncio.run(subject.install(environment))

        assert "Unable to locate package" in str(excinfo.value)
        assert "distribution's own C++ runtime is the ceiling" not in str(
            excinfo.value
        )
        # Nothing was written to the task container, and node was never probed.
        assert environment.uploads == []
        assert "tar xzf" not in "".join(environment.commands)
        assert not _calls(environment, "process.versions.node")


def _pass_through_root_exec(environment: _NodePathEnvironment):
    """Make `exec_as_root` record into the same stub as `exec`.

    The adapter's own `exec_as_root` prepends `set -o pipefail;` and raises on
    a non-zero exit. The recorded stream has to be the one the real call path
    produces — with the prefix, which is what makes the probe's `|| true`
    load-bearing — so this is not `lambda *a: a.exec(*a)`.
    """

    async def exec_as_root(env, command, **_ignored):
        return await env.exec(command=f"set -o pipefail; {command}", user="root")

    return exec_as_root


class TestGlibcxxProbe:
    """The probe is run for real; a string assertion cannot tell it from a wrong one."""

    def test_a_real_libstdcxx_fixture_yields_the_numeric_maximum(self, tmp_path):
        # The version tokens of a real libstdc++ are not in ascending order, and
        # their lexicographic maximum is GLIBCXX_3.4.9 — thirty-one releases
        # short of the ceiling. So a probe that ended in `sort -u | tail -1`
        # would report 3.4.9 here and `_glibcxx_at_least` would refuse an image
        # that has the runtime. This runs the adapter's own probe command under
        # the same `set -o pipefail` prefix harbor prepends, and asserts the
        # verdict the adapter derives from it. A missing `sort -V` — or any
        # replacement that keeps the ordering in the shell — fails here.
        so = tmp_path / "libstdc++.so.6"
        so.write_bytes(
            b"\x00\x01binary\xff"
            + b"\x00".join(token.encode() for token in _LIBSTDCXX_TOKENS)
            + b"\x00tail\xfe"
        )

        result = _run_probe((str(so),))

        assert result.returncode == 0, result.stderr
        # Every match is emitted, in the order the shell found them. This is
        # the behavioural contract, and it is what fails if the ordering is put
        # back in the shell: any `sort ... | tail -1` collapses the stream to
        # one line, so the probe would no longer be reporting the library's
        # tokens and Python would no longer be choosing among them.
        assert result.stdout.split() == list(_LIBSTDCXX_TOKENS)
        ceiling = _glibcxx_ceiling(result.stdout)
        assert ceiling == "GLIBCXX_3.4.30"
        assert _glibcxx_at_least(ceiling, REQUIRED_GLIBCXX) is False
        # The trap itself: the lexicographic maximum of this very output. A
        # plain `sort -u | tail -1` would report 3.4.9 here and refuse an image
        # that in fact carries 3.4.30.
        assert max(result.stdout.split(), key=str) == "GLIBCXX_3.4.9"

    def test_the_probe_orders_nothing_in_the_shell(self, tmp_path):
        # `sort -V` is a GNU extension, which is at odds with the POSIX-only
        # rationale the rest of the probe is built on; plain `sort` is worse
        # than cosmetic (see the fixture test above). The maximum is computed
        # in Python by `_glibcxx_ceiling`, from the same components the
        # pass/fail decision uses, so the ordering has one implementation.
        assert "sort" not in _GLIBCXX_CEILING_PROBE
        assert "tail" not in _GLIBCXX_CEILING_PROBE

    def test_the_guard_sits_inside_the_loop(self):
        # harbor prepends `set -o pipefail` to every command, and `grep` exits 1
        # when it matches nothing — so on an image with no readable
        # libstdc++.so.6 an unguarded loop aborts install() with
        # NonZeroAgentExitCodeError on precisely the image that most needs the
        # install to run. The guard has to be *inside* the loop: hoisting it
        # outside leaves every pipeline element still failing under pipefail.
        # Asserted positionally, because `|| true in probe` is satisfied by the
        # wrong placement.
        guard = _GLIBCXX_CEILING_PROBE.index("|| true")
        loop_end = _GLIBCXX_CEILING_PROBE.index("; done")
        assert guard < loop_end
        # And the whole-string verdict is the one a real shell produces on this
        # host, which has no libstdc++.so.6 at any of the probed paths.
        assert _NO_LIBSTDCXX_VERDICT.returncode == 0

    def test_the_probe_avoids_gnu_only_tools_found_missing_in_real_images(self):
        # `grep -a` is a GNU extension busybox does not implement — on Alpine it
        # extracted nothing, so the probe reported "none found" even with a
        # current libstdc++ installed. `strings` is the other obvious tool and
        # it is absent from the Debian task images (verified: `command -v
        # strings` is empty in alexgshaw/fix-git:20260403). What is left has to
        # be POSIX, because harbor's docker backend runs `bash -c` on some
        # images and busybox `sh` on others.
        probe = _GLIBCXX_CEILING_PROBE
        assert "grep -a" not in probe
        assert "strings" not in probe
        # `tr` splits the binary into one token per line and the match is
        # whole-line, which is what makes the extraction work without -a.
        assert "tr -c" in probe
        assert "^GLIBCXX_[0-9.]+$" in probe


class TestGlibcxxCeiling:
    """The maximum is computed here, and it is the numeric one."""

    def test_the_maximum_is_numeric_not_lexicographic(self):
        # The output of a real probe: the last token libstdc++ has carried for
        # years is the lexicographic max, and the newest is not. A byte-ordered
        # max would answer 3.4.9 for the library below and reject a runtime that
        # is eleven releases short of nothing.
        stream = _glibcxx_stream("GLIBCXX_3.4.35")

        assert _glibcxx_ceiling(stream) == "GLIBCXX_3.4.35"
        assert max(stream.split()) == "GLIBCXX_3.4.9"

    def test_an_unparseable_stream_yields_no_ceiling_at_all(self):
        # The probe's output is a container-controlled string. One odd line —
        # or a wholly unexpected one — must degrade to "no runtime found", not
        # to an exception out of a version check.
        assert _glibcxx_ceiling("") == ""
        assert _glibcxx_ceiling("bash: tr: command not found\n") == ""
        assert _glibcxx_ceiling("GLIBCXX_3.4.30\nCXXABI_1.3.9\n") == "GLIBCXX_3.4.30"


class TestCxxRuntimeInstallTable:
    """Package name, install command and exec env are one row per manager."""

    def test_every_supported_manager_has_a_complete_row(self):
        # The table is a single mapping precisely so it cannot drift: a manager
        # present in a "packages" dict and missing from a "commands" dict used
        # to be a bare `KeyError` from `install()`, with no remedy in the
        # message. `_cxx_runtime_install` is the only reader and it raises.
        assert set(_CXX_RUNTIME_INSTALLS) == {"apt-get", "apk", "dnf", "yum"}
        for manager, (package, command, env) in _CXX_RUNTIME_INSTALLS.items():
            assert package, manager
            assert command, manager
            assert env is None or all(
                key.isupper() and value for key, value in env.items()
            )

    def test_a_manager_with_no_row_raises_a_readable_error(self):
        with pytest.raises(IKnowInstallError, match="pacman"):
            _cxx_runtime_install("pacman")

    @pytest.mark.parametrize("manager", ["apt-get", "apk", "dnf", "yum"])
    def test_the_package_name_is_never_sought_under_the_wrong_spelling(
        self, manager
    ):
        package, _command, _env = _cxx_runtime_install(manager)
        # `libstdc++6` is the Debian soname spelling; asking apk/dnf/yum for it
        # resolves to nothing, so the two must never be mixed up by a table
        # edit. (`libstdc++` is a prefix of `libstdc++6`, so the comparison has
        # to be equality against the row, not `in`.)
        assert (package == "libstdc++6") == (manager == "apt-get")

    def test_only_apt_refreshes_a_cache_and_answers_debconf(self):
        # The apt row carries an index refresh and DEBIAN_FRONTEND; the others
        # need neither (`apk --no-cache` refreshes inline, and dnf/yum refresh
        # their metadata as a side effect of the transaction). Asserted here as
        # well as through the issued command, so a row edited in isolation is
        # caught by the table test and not only by a happy path.
        assert _cxx_runtime_install("apt-get")[1].startswith("apt-get update &&")
        assert _cxx_runtime_install("apt-get")[2] == {
            "DEBIAN_FRONTEND": "noninteractive"
        }
        for manager in ("apk", "dnf", "yum"):
            assert _cxx_runtime_install(manager)[1].count("update") == 0, manager
            assert _cxx_runtime_install(manager)[2] is None, manager


class TestGlibcxxComparison:
    """Version ordering is numeric; a string compare would accept 3.4.9."""

    @pytest.mark.parametrize(
        ("observed", "expected"),
        [
            ("GLIBCXX_3.4.31", True),
            ("GLIBCXX_3.4.32", True),
            ("GLIBCXX_3.4.30", False),
            # The lexicographic trap: "3.4.9" > "3.4.31" as text, and it is
            # actually eleven releases short.
            ("GLIBCXX_3.4.9", False),
            ("GLIBCXX_3.4.4", False),
            ("GLIBCXX_3.3.11", False),
            ("", False),
            (None, False),
            ("   ", False),
            ("not a version", False),
            ("GLIBCXX_", False),
            ("CXXABI_1.3.9", False),
            # `str.isdigit()` is true for superscripts and other non-ASCII
            # digits, and `int()` raises on those — so the predicate has to be
            # total, not just correct for the ASCII tokens the probe emits.
            ("GLIBCXX_3.4.²", False),
            ("GLIBCXX_٣.٤.٣١", False),
        ],
    )
    def test_only_a_numeric_ceiling_at_or_above_the_requirement_passes(
        self, observed, expected
    ):
        assert _glibcxx_at_least(observed, REQUIRED_GLIBCXX) is expected


class TestEnsureNode:
    """A probe that sources nvm.sh does not prove a fresh shell sees node."""

    def test_an_nvm_only_install_is_linked_even_when_the_probe_passes(self, tmp_path):
        environment = _NodePathEnvironment(
            {
                # Both probes are the same text; the first sources nvm.sh and
                # finds node, the second does not. The `if [ -s` guard tells
                # the first probe apart, and the *order* of the remaining two
                # (plain-shell check, then the post-link proof) is what the
                # two-entry replay under the floor probe carries.
                # The guard needle is deliberately not `nvm.sh` itself: the nvm
                # *install* snippet mentions nvm.sh too.
                "if [ -s": ("", "", 0),
                "process.versions.node": [("", "", 127), ("v22.23.3", "", 0)],
                "ls -1": ("/root/.nvm/versions/node/v22.23.3/bin/node\n", "", 0),
            }
        )
        subject = agent(tmp_path)
        subject.ensure_system_dependencies = _no_op

        asyncio.run(subject._ensure_node(environment))

        assert _calls(environment, "ln -sf")
        assert _calls(environment, "process.versions.node")

    def test_an_image_without_node_is_installed_through_nvm_and_then_linked(
        self, tmp_path
    ):
        # The path a real ubuntu:24.04 trial took: no node at all, so the
        # nvm install snippet runs before the link step. Nothing else covers
        # that branch, and it is the one the failing trial exercised.
        environment = _NodePathEnvironment(
            {
                "if [ -s": ("", "bash: node: command not found", 127),
                "nvm install": ("", "", 0),
                "ls -1": ("/root/.nvm/versions/node/v22.23.3/bin/node\n", "", 0),
                "process.versions.node": ("v22.23.3", "", 0),
            }
        )
        subject = agent(tmp_path)
        subject.ensure_system_dependencies = _no_op

        asyncio.run(subject._ensure_node(environment))

        assert _calls(environment, "nvm install")
        assert _calls(environment, "ln -sf") == [
            (
                "set -o pipefail; ln -sf /root/.nvm/versions/node/v22.23.3/bin/node"
                " /usr/local/bin/node"
            )
        ]
        # The install is issued as the agent user, the symlink as root: root
        # cannot read the agent's nvm tree, and the agent cannot write
        # /usr/local/bin.
        install_index = next(
            index
            for index, command in enumerate(environment.commands)
            if "nvm install" in command
        )
        assert environment.users[install_index] is None
        assert environment.users[install_index + 2] == "root"

    def test_a_node_already_on_the_plain_path_is_left_alone(self, tmp_path):
        environment = _NodePathEnvironment(
            {
                "if [ -s": ("", "", 0),
                "process.versions.node": ("", "", 0),
            }
        )
        subject = agent(tmp_path)
        subject.ensure_system_dependencies = _no_op

        asyncio.run(subject._ensure_node(environment))

        assert not _calls(environment, "ln -sf")
        assert not any("nvm install" in command for command in environment.commands)


class TestNodePathLink:
    """The nvm binary must be located by the nvm tree, not by the PATH."""

    def test_link_does_not_depend_on_an_nvm_initialized_path(self, tmp_path):
        environment = _NodePathEnvironment(
            {
                # The nvm tree holds the binary even though the ambient PATH
                # of a fresh shell resolves none: this is what a real
                # ubuntu:24.04 container reported.
                "ls -1": ("/root/.nvm/versions/node/v22.23.3/bin/node\n", "", 0),
                "process.versions.node": ("v22.23.3", "", 0),
            }
        )
        subject = agent(tmp_path)

        asyncio.run(subject._link_node_onto_system_path(environment))

        # The lookup sees the nvm tree even though the ambient PATH is empty,
        # and the root step symlinks the absolute path it found.
        assert _calls(environment, "ln -sf") == [
            (
                "set -o pipefail; ln -sf /root/.nvm/versions/node/v22.23.3/bin/node"
                " /usr/local/bin/node"
            )
        ]
        assert "$NVM_DIR" in environment.commands[0] or ".nvm" in environment.commands[0]
        # A `command -v node` lookup is the ambient-PATH dependency that
        # silently produced no symlink in a real ubuntu:24.04 container.
        assert not any(
            "command -v node" in command for command in environment.commands
        )
        assert environment.users[1] == "root"  # the `ln -sf` runs as root

    def test_the_linked_node_is_proven_in_a_plain_shell(self, tmp_path):
        environment = _NodePathEnvironment(
            {
                "ls -1": ("/root/.nvm/versions/node/v22.23.3/bin/node\n", "", 0),
                "process.versions.node": ("", "bash: node: command not found", 127),
            }
        )
        subject = agent(tmp_path)

        with pytest.raises(IKnowNodeUnavailableError, match="command not found"):
            asyncio.run(subject._link_node_onto_system_path(environment))

        assert _calls(environment, "process.versions.node")

    def test_a_multi_version_tree_links_the_newest_not_the_byte_last(self, tmp_path):
        # `ls -1` is byte-sorted, so v9.11.2 comes *last* in a tree that also
        # holds v22.23.3. Taking the last line links node 9, which runs fine
        # and then cannot parse dist/cli.js -- silently, at no error anywhere.
        environment = _NodePathEnvironment(
            {
                "ls -1": (
                    (
                        "/root/.nvm/versions/node/v18.20.4/bin/node\n"
                        "/root/.nvm/versions/node/v22.23.3/bin/node\n"
                        "/root/.nvm/versions/node/v9.11.2/bin/node\n"
                    ),
                    "",
                    0,
                ),
                "process.versions.node": ("v22.23.3", "", 0),
            }
        )
        subject = agent(tmp_path)

        asyncio.run(subject._link_node_onto_system_path(environment))

        assert _calls(environment, "ln -sf") == [
            (
                "set -o pipefail; ln -sf /root/.nvm/versions/node/v22.23.3/bin/node"
                " /usr/local/bin/node"
            )
        ]

    def test_a_tree_of_only_legacy_nodes_links_nothing(self, tmp_path):
        # Every candidate is below NODE_MAJOR_FLOOR. Downgrading silently is
        # the bug; linking nothing and saying so is the contract.
        environment = _NodePathEnvironment(
            {
                "ls -1": (
                    (
                        "/root/.nvm/versions/node/v18.20.4/bin/node\n"
                        "/root/.nvm/versions/node/v9.11.2/bin/node\n"
                    ),
                    "",
                    0,
                ),
            }
        )
        subject = agent(tmp_path)

        with pytest.raises(IKnowNodeUnavailableError, match="below major 20"):
            asyncio.run(subject._link_node_onto_system_path(environment))

        assert not _calls(environment, "ln -sf")

    def test_the_floor_follows_the_linked_binary_not_the_glob_order(self, tmp_path):
        # A directory nvm does not name `vN.N.N` cannot be ranked, so it is
        # never linked even when it is the only thing in the tree.
        environment = _NodePathEnvironment(
            {"ls -1": ("/root/.nvm/versions/node/now/bin/node\n", "", 0)}
        )
        subject = agent(tmp_path)

        with pytest.raises(IKnowNodeUnavailableError, match="no node binary"):
            asyncio.run(subject._link_node_onto_system_path(environment))

        assert not _calls(environment, "ln -sf")

    def test_an_empty_nvm_tree_is_an_error_not_a_skipped_step(self, tmp_path):
        environment = _NodePathEnvironment({"ls -1": ("", "", 0)})
        subject = agent(tmp_path)

        with pytest.raises(IKnowNodeUnavailableError, match="no node binary"):
            asyncio.run(subject._link_node_onto_system_path(environment))

        assert not _calls(environment, "ln -sf")


class TestSmokeTestAttribution:
    """A missing node must not be reported as a glibc problem, and vice versa."""

    def test_missing_node_is_not_reported_as_glibc(self, tmp_path):
        environment = _StubEnvironment(
            stdout="", return_code=127
        )
        subject = agent(tmp_path)
        environment.exec = _replaying(
            ("", "bash: line 1: node: command not found", 127)
        )

        with pytest.raises(IKnowNodeUnavailableError) as excinfo:
            asyncio.run(subject._assert_bundle_runtime(environment, "/root"))

        assert not isinstance(excinfo.value, IKnowGlibcRequiredError)
        assert "/usr/local/bin/node" in str(excinfo.value)

    def test_a_native_addon_load_failure_is_still_a_glibc_error(self, tmp_path):
        environment = _StubEnvironment()
        subject = agent(tmp_path)
        environment.exec = _replaying(
            (
                f"{_NODE_MARKER}\n",
                (
                    "Error: Cannot find module 'tree-sitter-bash'\n"
                    "NODE_MODULE_VERSION 127\n"
                ),
                1,
            )
        )

        with pytest.raises(IKnowGlibcRequiredError):
            asyncio.run(subject._assert_bundle_runtime(environment, "/root"))

    def test_a_missing_marker_means_node_never_ran(self, tmp_path):
        # A glibc-hostile loader can word its refusal in ways the
        # command-not-found matcher does not cover; the marker is the fact.
        environment = _StubEnvironment()
        subject = agent(tmp_path)
        environment.exec = _replaying(("", "could not open the shared object", 1))

        with pytest.raises(IKnowNodeUnavailableError):
            asyncio.run(subject._assert_bundle_runtime(environment, "/root"))

    def test_a_missing_shared_library_after_node_ran_is_a_glibc_error(self, tmp_path):
        # Verbatim dlopen failure shape from a slim task image. "No such file
        # or directory" reads like command-not-found but arrives *after* node
        # printed the marker, so reporting "node never ran" would send the
        # reader to fix a PATH that is already correct.
        environment = _StubEnvironment()
        subject = agent(tmp_path)
        environment.exec = _replaying(
            (
                f"{_NODE_MARKER}\n",
                (
                    "node: error while loading shared libraries: libstdc++.so.6: "
                    "cannot open shared object file: No such file or directory\n"
                ),
                127,
            )
        )

        with pytest.raises(IKnowGlibcRequiredError) as excinfo:
            asyncio.run(subject._assert_bundle_runtime(environment, "/root"))

        assert not isinstance(excinfo.value, IKnowNodeUnavailableError)

    def test_the_smoke_test_proves_more_than_the_cli_reports_itself(self, tmp_path):
        # The native leg is the point: `dist/cli.js --version` can pass while
        # the addons it loads lazily cannot. Asserting on the command text
        # proved nothing, so this drives the failure and names the error class.
        environment = _StubEnvironment()
        subject = agent(tmp_path)
        environment.exec = _replaying(
            (
                f"{_NODE_MARKER}\n",
                "Error: Cannot find module 'tree-sitter'\n",
                1,
            )
        )

        with pytest.raises(IKnowGlibcRequiredError) as excinfo:
            asyncio.run(subject._assert_bundle_runtime(environment, "/root"))

        assert "glibc" in str(excinfo.value)


def _replaying(result: tuple[str, str, int]):
    async def exec(command: str, **_ignored):
        return SimpleNamespace(
            return_code=result[2], stdout=result[0], stderr=result[1]
        )

    return exec


async def _no_op(*_args, **_ignored):
    return None


class TestEvalStateCarrier:
    """ADR-0130 §1: eval state is argv-named, never an in-container env flip."""

    def _subject(self, tmp_path, eval_state: bool) -> IKnowAgent:
        subject = IKnowAgent(
            logs_dir=tmp_path,
            model_name=MODEL_ROUTE,
            bundle_path="/tmp/iknow-bundle.tgz",
            eval_state=eval_state,
        )
        subject._extra_env = {MINIMAX_API_KEY_ENV: "test-key"}
        return subject

    def test_flag_reaches_argv_and_the_env_stays_unforwarded(self, tmp_path):
        subject = self._subject(tmp_path, True)

        command = subject._ask_command("q", subject.options, home="/root")
        runtime_env = subject._runtime_env(subject.options)

        assert EVAL_STATE_FLAG in command
        assert f"--json {EVAL_STATE_FLAG}" in command
        assert EVAL_STATE_ENV not in runtime_env
        assert runtime_env[PERMISSION_MODE_ENV] == "full_auto"
        assert runtime_env[MINIMAX_API_KEY_ENV] == "test-key"

    def test_no_flag_when_the_posture_is_off(self, tmp_path):
        subject = self._subject(tmp_path, False)

        command = subject._ask_command("q", subject.options, home="/root")

        assert EVAL_STATE_FLAG not in command

    def test_probe_refuses_a_bundle_that_cannot_name_the_posture(self, tmp_path):
        subject = self._subject(tmp_path, True)
        environment = _StubEnvironment(stdout="Usage: iknow ask <prompt>\n")

        with pytest.raises(IKnowEvalStateUnsupportedError, match="Rebuild"):
            asyncio.run(subject._assert_eval_state_flag(environment, "/root"))

    def test_probe_passes_when_the_flag_is_advertised(self, tmp_path):
        subject = self._subject(tmp_path, True)
        environment = _StubEnvironment(
            stdout=f"  {EVAL_STATE_FLAG}  评测态：围栏整体退场，不落盘\n"
        )

        asyncio.run(subject._assert_eval_state_flag(environment, "/root"))

        assert "--help" in environment.commands[0]

    def test_probe_is_skipped_entirely_when_the_posture_is_off(self, tmp_path):
        subject = self._subject(tmp_path, False)
        environment = _StubEnvironment(stdout="")

        asyncio.run(subject._assert_eval_state_flag(environment, "/root"))

        assert environment.commands == []


class TestRunStateLabel:
    """ADR-0130 §5: the label on the record has to be the one the run gave itself."""

    def _subject(self, tmp_path, eval_state: bool) -> IKnowAgent:
        return IKnowAgent(
            logs_dir=tmp_path,
            model_name=MODEL_ROUTE,
            bundle_path="/tmp/iknow-bundle.tgz",
            eval_state=eval_state,
        )

    def test_agreeing_label_is_accepted_in_both_directions(self, tmp_path):
        labeled = ParsedRun(
            kind="answer", final_text="a", run_state=EVAL_STATE_RUN_LABEL
        )

        self._subject(tmp_path, True)._assert_run_state_named(
            labeled, self._subject(tmp_path, True).options
        )
        self._subject(tmp_path, False)._assert_run_state_named(
            ParsedRun(kind="answer", final_text="a"),
            self._subject(tmp_path, False).options,
        )

    def test_an_unlabelled_answer_never_scores_as_eval_state(self, tmp_path):
        subject = self._subject(tmp_path, True)

        with pytest.raises(IKnowRunStateMismatchError, match="runState=None"):
            subject._assert_run_state_named(
                ParsedRun(kind="answer", final_text="a"), subject.options
            )

    def test_a_label_that_was_not_asked_for_errors_too(self, tmp_path):
        subject = self._subject(tmp_path, False)

        with pytest.raises(IKnowRunStateMismatchError, match="eval_state=False"):
            subject._assert_run_state_named(
                ParsedRun(kind="answer", run_state=EVAL_STATE_RUN_LABEL),
                subject.options,
            )

    def test_error_envelopes_are_left_to_their_own_error(self, tmp_path):
        subject = self._subject(tmp_path, True)

        subject._assert_run_state_named(
            ParsedRun(kind="error_envelope", error_code=_MAX_TURNS_ERROR),
            subject.options,
        )

    def test_the_posture_lands_on_the_trial_metadata(self, tmp_path):
        subject = self._subject(tmp_path, True)

        metadata = _run_metadata(ParsedRun(kind="answer", turn_count=3), subject.options)

        assert metadata == {
            "permission_mode": "full_auto",
            "eval_state": True,
            "turn_count": 3,
        }


# The container path the adapter hands `--trace-out`, and the answer iknow's
# JSON carries alongside it. Both are observed shapes, not guesses: the JSON is
# verbatim from a real `iknow ask --json --eval-state --trace-out` run against a
# loopback model stub, and the flag's directory semantics are
# src/harness/trace/jsonl.ts:192-197.
ANSWER_JSON = (
    '{"finalText":"done","stopReason":"completed","turnCount":3,'
    '"lastUsage":{"inputTokens":5,"outputTokens":3,'
    '"cacheCreationInputTokens":null,"cacheReadInputTokens":null},'
    '"runState":"eval_state"}'
)
# iknow's warn-once notice when the JSONL writer cannot write, observed on the
# merged stream of the same run pointed at a regular file.
TRACE_WRITE_FAILURE_NOTICE = (
    "[JsonlTraceService] write failed: Error: ENOTDIR: not a directory, "
    "mkdir '/logs/agent/trace/blobs'\n"
)
TRACE_WRITE_FAILURE_OUTPUT = TRACE_WRITE_FAILURE_NOTICE + ANSWER_JSON
# A capped run prints the max-turns envelope and no answer at all, so the
# fixture is the notice plus the envelope — not the answer, which would win the
# parser's answer-over-envelope precedence and stop the run from being capped.
TRACE_WRITE_FAILURE_CAPPED_OUTPUT = (
    TRACE_WRITE_FAILURE_NOTICE + '{"error":"max_turns_exceeded","turnsRan":40}'
)


class TestTraceOutCarrier:
    """Per-turn trajectories, retained as a trial artifact and only on request.

    The pilot report (§8) names what their absence cost: the loop diagnosis for
    the scored trials, the tool-selection reading, and the classification of a
    second hard-wall deny whose command text was never captured. The option is
    therefore off by default — a scripted run must behave byte-for-byte as it
    did — and on only when a trial asks for it.
    """

    def _subject(self, tmp_path, **kwargs) -> IKnowAgent:
        subject = IKnowAgent(
            logs_dir=tmp_path,
            model_name=MODEL_ROUTE,
            bundle_path="/tmp/iknow-bundle.tgz",
            **kwargs,
        )
        subject._extra_env = {MINIMAX_API_KEY_ENV: "test-key"}
        return subject

    def test_the_flag_is_absent_by_default(self, tmp_path):
        subject = self._subject(tmp_path)

        command = subject._ask_command("q", subject.options, home="/root")

        assert TRACE_OUT_FLAG not in command
        assert subject.options.trace_out is False
        # The pre-existing command is unchanged: the trace dir is not created
        # and the metadata carries no trace key, so a default run is byte-for-byte
        # the one the pilot measured.
        assert "mkdir -p /logs/agent &&" in command
        assert "trace" not in _run_metadata(ParsedRun(kind="answer"), subject.options)

    def test_the_flag_reaches_argv_with_the_agent_log_dir_path(self, tmp_path):
        subject = self._subject(tmp_path, trace_out=True)

        command = subject._ask_command("q", subject.options, home="/root")

        assert f"{TRACE_OUT_FLAG} /logs/agent/{_TRACE_DIRNAME}" in command
        assert subject.options.trace_out is True

    def test_the_flag_travels_on_argv_and_no_env_is_forwarded(self, tmp_path):
        # Same discipline as the eval-state posture: a flag on the command line,
        # never an env var. IKNOW_TRACE_OUT is the *adapter option's* fallback
        # for `--ae`; iknow reads it, but the adapter must not inject it, or a
        # host var would silently turn tracing on for a trial that did not ask
        # for it (src/cli/trace-root.ts:27-37 reads the same var).
        subject = self._subject(tmp_path, trace_out=True)

        runtime_env = subject._runtime_env(subject.options)

        assert TRACE_OUT_ENV not in runtime_env
        assert TRACE_OUT_FLAG in subject._ask_command(
            "q", subject.options, home="/root"
        )

    def test_the_parent_directory_is_created_before_the_ask_runs(self, tmp_path):
        # iknow's own mkdir is deferred to the first record and lives behind an
        # injectable writer, so the adapter creates the parent itself rather
        # than depend on a detail two layers down. The mkdir must precede the
        # `cd`, and must name the trace dir as its own -p argument.
        subject = self._subject(tmp_path, trace_out=True)

        command = subject._ask_command("q", subject.options, home="/root")

        assert "mkdir -p /logs/agent /logs/agent/trace && cd /root/iknow &&" in command
        # Two arguments, not one joined path: `-p a b` is what creates both.
        mkdir_args = command.split("mkdir -p ", 1)[1].split(" &&", 1)[0].split(" ")
        assert mkdir_args == ["/logs/agent", f"/logs/agent/{_TRACE_DIRNAME}"]

    def test_the_emitted_command_creates_the_trace_dir_in_a_real_shell(self, tmp_path):
        """The emitted string, run by a real shell — not asserted as a string.

        The `mkdir -p` half and the argv split are two different failure modes:
        a command that names the right path but creates no directory leaves
        iknow to fail its first record write, and a command that creates the
        directory but hands `--trace-out` two argv tokens makes the parser
        consume the next flag as the path. Running the produced command is what
        distinguishes them. A stub `node` stands in for the CLI, so nothing
        here needs a model or a network.
        """
        root = Path(tmp_path) / "fake-root"
        install = root / "root" / "iknow"
        bindir = root / "bin"
        for directory in (install, bindir):
            directory.mkdir(parents=True)
            directory.chmod(0o777)
        stub = bindir / "node"
        stub.write_text(
            "#!/bin/sh\n"
            'prev=""; dir=""\n'
            'for arg in "$@"; do\n'
            '  if [ "$prev" = "--trace-out" ]; then dir="$arg"; fi\n'
            '  prev="$arg"\n'
            "done\n"
            'if [ -z "$dir" ]; then echo "no --trace-out on argv" >&2; exit 3; fi\n'
            'case "$dir" in /*) ;; *) echo "path split: $dir" >&2; exit 4;; esac\n'
            'mkdir -p "$dir" && : > "$dir/probe.jsonl"\n'
            "exit 0\n"
        )
        stub.chmod(0o755)
        log_dir = root / "logs" / "agent"

        subject = self._subject(tmp_path, trace_out=True)
        command = subject._ask_command("q", subject.options, home=str(root / "root"))
        # The command carries absolute container paths; rewriting only the
        # /logs prefix and the home leaves every other byte — the quoting, the
        # flag order, the pipe — exactly as the adapter produced it.
        real = command.replace("/logs/agent", log_dir.as_posix())
        proc = subprocess.run(
            ["bash", "-c", real],
            capture_output=True,
            text=True,
            cwd=str(root),
            env={"PATH": f"{bindir}:{os.environ['PATH']}"},
        )

        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert (log_dir / _TRACE_DIRNAME / "probe.jsonl").is_file()
        assert (log_dir / "iknow-ask.txt").is_file()

    @pytest.mark.parametrize(
        ("path", "quoted"),
        [
            ("/logs/agent/trace", False),
            ("/logs/agent/with space", True),
            ("/logs/agent/trace;touch /tmp/pwned", True),
            ("/logs/agent/tr'ace", True),
        ],
    )
    def test_the_trace_path_is_quoted_safely(self, tmp_path, monkeypatch, path, quoted):
        # The path is built from EnvironmentPaths, not operator input, so the
        # realistic case is the benign one; the injection cases assert the
        # property that holds either way — a path with a space or a shell
        # metacharacter still arrives as one argv token, and is never spliced
        # into the command unquoted.
        monkeypatch.setattr(agent_module, "_trace_out_dir", lambda: path)
        subject = self._subject(tmp_path, trace_out=True)

        command = subject._ask_command("q", subject.options, home="/root")

        token = command.split(f"{TRACE_OUT_FLAG} ", 1)[1].split(" 2>&1", 1)[0]
        assert (token != path) is quoted
        if quoted:
            assert token == shlex.quote(path)
        # And the shell agrees: the token survives `bash -c` as one argument.
        read = subprocess.run(
            ["bash", "-c", f"for a in {token}; do printf '%s\\n' \"$a\"; done"],
            capture_output=True,
            text=True,
            check=True,
        )
        assert read.stdout.rstrip("\n") == path

    def test_the_requested_dir_lands_on_the_trial_metadata(self, tmp_path):
        subject = self._subject(tmp_path, trace_out=True)

        metadata = _run_metadata(
            ParsedRun(kind="answer", turn_count=3),
            subject.options,
            trace_state=_TRACE_PROBE_PRESENT,
        )

        # A directory, not a file: the file is `<dir>/<conversationId>.jsonl`
        # and the conversation id is minted inside the container, so naming a
        # file here would assert a path the adapter never saw.
        assert metadata == {
            "permission_mode": "full_auto",
            "eval_state": False,
            "trace_out": f"/logs/agent/{_TRACE_DIRNAME}",
            "trace_state": _TRACE_PROBE_PRESENT,
            "turn_count": 3,
        }

    def test_a_run_that_never_wrote_a_trace_says_so(self, tmp_path):
        # The gap the review found: a real `ask --trace-out` with no API key
        # printed the provider envelope, exited 1, and left the trace dir
        # holding zero files — with no notice on the output stream, so the
        # parse alone cannot see it. Without this key the record reads as
        # "a trajectory is here" for a trial that has none.
        subject = self._subject(tmp_path, trace_out=True)
        context = SimpleNamespace(
            metadata=None, n_input_tokens=0, n_cache_tokens=0, n_output_tokens=0
        )
        environment = _NodePathEnvironment(
            {
                'printf %s "$HOME"': ("/root", "", 0),
                "dist/cli.js ask": (
                    '{"error":"llm_provider_api_key_missing",'
                    '"code":"provider_api_key_missing"}',
                    "",
                    1,
                ),
                # No `*.jsonl` on disk — the zero-file directory.
                "/logs/agent/trace/*.jsonl": (_TRACE_PROBE_EMPTY, "", 0),
            }
        )

        with pytest.raises(Exception):
            asyncio.run(subject.run("q", environment, context))

        # The run raised (a missing key is a real trial error), so the receipt
        # is asserted where the caller can still see it: on the capped branch,
        # which is the one path out of run() that returns without raising.
        state = asyncio.run(
            subject._probe_trace_dir(environment, subject.options)
        )
        metadata = _run_metadata(
            ParsedRun(kind="none"), subject.options, trace_state=state
        )
        assert metadata["trace_state"] == _TRACE_PROBE_EMPTY
        assert "trace_write_failed" not in metadata

    @pytest.mark.parametrize(
        ("probe_stdout", "expected"),
        [
            (_TRACE_PROBE_PRESENT, _TRACE_PROBE_PRESENT),
            (_TRACE_PROBE_EMPTY, _TRACE_PROBE_EMPTY),
            (_TRACE_PROBE_ABSENT, _TRACE_PROBE_ABSENT),
            # An unreadable probe must never read as a present trajectory.
            ("", _TRACE_PROBE_ABSENT),
            ("something else entirely", _TRACE_PROBE_ABSENT),
        ],
    )
    def test_the_probe_reports_the_directory_state(
        self, tmp_path, probe_stdout, expected
    ):
        subject = self._subject(tmp_path, trace_out=True)
        environment = _StubEnvironment(stdout=probe_stdout)

        state = asyncio.run(
            subject._probe_trace_dir(environment, subject.options)
        )

        assert state == expected

    def test_the_probe_is_skipped_when_tracing_was_not_requested(self, tmp_path):
        # `absent` is not a synonym for `off`: without this the metadata would
        # claim every default trial lost a trace it never asked for.
        subject = self._subject(tmp_path, trace_out=False)
        environment = _StubEnvironment(stdout=_TRACE_PROBE_PRESENT)

        state = asyncio.run(
            subject._probe_trace_dir(environment, subject.options)
        )

        assert state is None
        assert environment.commands == []
        metadata = _run_metadata(ParsedRun(kind="answer"), subject.options, state)
        assert "trace_state" not in metadata
        assert "trace_out" not in metadata

    def test_the_probe_reads_the_directory_in_a_real_shell(self, tmp_path):
        # The three states are filesystem states, so they are established on a
        # real filesystem by the very command the adapter runs — not by
        # asserting the probe string. Same builder as `_run_probe`, because the
        # point is that the emitted text does the right thing on disk.
        root = tmp_path / "agent-log"
        trace_dir = root / _TRACE_DIRNAME
        probe = _trace_probe_command(trace_dir.as_posix())

        assert _run_trace_probe(probe, trace_dir) == _TRACE_PROBE_ABSENT

        trace_dir.mkdir(parents=True)
        assert _run_trace_probe(probe, trace_dir) == _TRACE_PROBE_EMPTY

        (trace_dir / "empty.jsonl").write_bytes(b"")
        assert _run_trace_probe(probe, trace_dir) == _TRACE_PROBE_EMPTY, (
            "a zero-byte .jsonl means the writer opened the file and the run "
            "then died; -s is what keeps it from counting as a trajectory"
        )

        (trace_dir / "real.jsonl").write_text('{"record_type":"llm_call"}\n')
        assert _run_trace_probe(probe, trace_dir) == _TRACE_PROBE_PRESENT

    def test_the_probe_survives_a_directory_name_with_a_space(self, tmp_path):
        # The container path has no space, but the command is quoted and must
        # not be quietly relying on that.
        root = tmp_path / "agent log"
        trace_dir = root / _TRACE_DIRNAME
        trace_dir.mkdir(parents=True)
        (trace_dir / "real.jsonl").write_text("{}\n")

        probe = _trace_probe_command(trace_dir.as_posix())

        assert _run_trace_probe(probe, trace_dir) == _TRACE_PROBE_PRESENT

    def test_a_lost_trace_write_is_reported_and_does_not_fail_the_run(self, tmp_path):
        # A trace that cannot be written must not cost the trial its answer:
        # iknow warns once and keeps going, and the run is still scoreable. But
        # "scoreable" must not be read as "the trajectory was retained", so the
        # loss is recorded on the trial record. Driven through run(), not
        # through the parser alone, so the whole path is covered: a lost trace
        # that instead raised would fail this with an exception.
        subject = self._subject(tmp_path, trace_out=True, eval_state=True)
        context = SimpleNamespace(
            metadata=None, n_input_tokens=0, n_cache_tokens=0, n_output_tokens=0
        )
        environment = _NodePathEnvironment(
            {
                'printf %s "$HOME"': ("/root", "", 0),
                "dist/cli.js ask": (TRACE_WRITE_FAILURE_OUTPUT, "", 0),
            }
        )

        asyncio.run(subject.run("q", environment, context))

        assert context.metadata is not None
        assert context.metadata["trace_write_failed"] is True
        assert context.metadata["trace_out"] == f"/logs/agent/{_TRACE_DIRNAME}"
        assert context.metadata["eval_state"] is True
        assert context.metadata["stop_reason"] == "completed"

    def test_a_trace_write_failure_reaches_the_trial_metadata(self, tmp_path):
        subject = self._subject(tmp_path, trace_out=True)

        parsed = parse_iknow_ask_output(TRACE_WRITE_FAILURE_OUTPUT)
        metadata = _run_metadata(parsed, subject.options)

        assert parsed.kind == "answer", "a failed trace write is not a failed run"
        assert parsed.turn_count == 3
        assert metadata["trace_write_failed"] is True
        assert metadata["trace_out"] == f"/logs/agent/{_TRACE_DIRNAME}"

    def test_a_clean_run_does_not_claim_a_trace_write_failure(self, tmp_path):
        subject = self._subject(tmp_path, trace_out=True)

        parsed = parse_iknow_ask_output(ANSWER_JSON)
        metadata = _run_metadata(parsed, subject.options)

        assert parsed.trace_write_failed is False
        assert "trace_write_failed" not in metadata

    def test_the_capped_turn_path_keeps_the_trace_receipt(self, tmp_path):
        # The pilot's two scored trials both hit the turn cap, so the capped
        # branch is the one that has to carry the receipt: it returns early,
        # before the answer assertions, and is the path a per-turn diagnosis
        # most needs.
        subject = self._subject(tmp_path, trace_out=True)
        context = SimpleNamespace(
            metadata=None, n_input_tokens=0, n_cache_tokens=0, n_output_tokens=0
        )
        environment = _NodePathEnvironment(
            {
                'printf %s "$HOME"': ("/root", "", 0),
                "dist/cli.js ask": (TRACE_WRITE_FAILURE_CAPPED_OUTPUT, "", 1),
            }
        )

        asyncio.run(subject.run("q", environment, context))

        assert context.metadata["trace_out"] == f"/logs/agent/{_TRACE_DIRNAME}"
        assert context.metadata["trace_write_failed"] is True
        assert context.metadata["iknow_error"] == _MAX_TURNS_ERROR

    def test_the_flag_composes_with_eval_state_and_max_turns(self, tmp_path):
        # `--trace-out` is a value-taking option on the `ask` entry and
        # `--eval-state` is accepted alongside it (verified against the real
        # parser, which returns both with no rejection). If a future posture
        # change made the pair incoherent, this is the test that should fail —
        # but today the trial that most needs its trajectory retained is an
        # eval-state trial, so they must combine.
        subject = self._subject(tmp_path, trace_out=True, eval_state=True, max_turns=40)

        command = subject._ask_command("q", subject.options, home="/root")

        assert f"--json {EVAL_STATE_FLAG} --max-turns 40" in command
        assert (
            f"--max-turns 40 {TRACE_OUT_FLAG} /logs/agent/{_TRACE_DIRNAME}" in command
        )


# The two shapes a developer plausibly has exported. `1` is what a developer who
# used iknow interactively would have (iknow's own IKNOW_TRACE_OUT takes a
# *path*, so any prior use left a path behind); both are here because the two
# shapes fail differently, and the path shape is the one that used to raise.
_TRACE_OUT_HOST_EXPORTS = ("1", "/tmp/some/path")


@pytest.mark.parametrize("exported", _TRACE_OUT_HOST_EXPORTS)
def test_a_host_trace_out_export_cannot_turn_tracing_on(tmp_path, monkeypatch, exported):
    """No `Env` fallback: the host environment cannot reach this option.

    Harbor's env fallback is not scoped to `--ae` — `get_env` falls through to
    `os.environ` (harbor/agents/base.py:178-181) — so an `Env` annotation here
    made a *host* variable sufficient to change a trial. Measured, with the
    annotation in place: `IKNOW_TRACE_OUT=1` and no kwarg gave
    `trace_out == True`, rewriting the argv and the log-dir tree of a run
    configured to be the pilot-measured baseline; `IKNOW_TRACE_OUT=/tmp/some/path`
    raised `ValueError: ... trace_out: Input should be a valid boolean` before
    any container started. The name collision is why the fallback had to go
    rather than be tightened: iknow ships IKNOW_TRACE_OUT as a *path* variable
    (src/cli/trace-root.ts:29), so it cannot also be this option's boolean.

    Monkeypatching `os.environ` puts the variable in the real lookup harbor
    reads, which is the behavior under test; the same two values are also
    exported for real in `IKNOW_TRACE_OUT=... pytest` (see the module docstring
    note in the PR body), because a stubbed environment lookup would not
    exercise harbor's `extra_env.get(key) or os.environ.get(key)`.
    """
    monkeypatch.setenv(TRACE_OUT_ENV, exported)

    subject = agent(tmp_path)

    assert subject.options.trace_out is False
    assert TRACE_OUT_FLAG not in subject._ask_command(
        "q", subject.options, home="/root"
    )
    assert TRACE_OUT_ENV not in subject._runtime_env(subject.options)


def test_the_option_carries_no_env_fallback_at_all():
    """The structural half of the fix: the annotation is simply absent.

    Asserted through the schema rather than only through behavior, so a future
    edit that re-adds `Env(...)` fails here even if a coupled behavior test
    happened to survive it.
    """
    metadata = list(IKnowOptions.model_fields["trace_out"].metadata)

    assert not any(isinstance(item, Env) for item in metadata), (
        f"trace_out must not declare an Env fallback; got {metadata}"
    )
