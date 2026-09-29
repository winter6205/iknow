import asyncio
import json
from types import SimpleNamespace

import pytest
from harbor.agents.installed.base import (
    AgentAuthenticationError,
    ApiRateLimitError,
    ModelNotFoundError,
    NonZeroAgentExitCodeError,
)

from iknow_harbor import IKnowAgent
from iknow_harbor.agent import (
    _MAX_TURNS_ERROR,
    _NODE_MARKER,
    EVAL_STATE_ENV,
    EVAL_STATE_FLAG,
    EVAL_STATE_RUN_LABEL,
    MINIMAX_API_KEY_ENV,
    PERMISSION_MODE_ENV,
    IKnowEvalStateUnsupportedError,
    IKnowGlibcRequiredError,
    IKnowNodeUnavailableError,
    IKnowRunStateMismatchError,
    _run_metadata,
    render_iknow_settings,
)
from iknow_harbor.ask_output import ParsedRun

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
    """

    def __init__(self, results, default=("", "", 0)):
        super().__init__()
        self._results = {
            needle: (list(value) if isinstance(value, list) else [value])
            for needle, value in results.items()
        }
        self._default = default
        self.users: list[str | None] = []

    async def exec(self, command: str, user=None, **_ignored):
        self.commands.append(command)
        self.users.append(user)
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


def _calls(environment: _StubEnvironment, needle: str) -> list[str]:
    return [command for command in environment.commands if needle in command]


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
