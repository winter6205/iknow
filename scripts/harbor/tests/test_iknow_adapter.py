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
    EVAL_STATE_ENV,
    EVAL_STATE_FLAG,
    EVAL_STATE_RUN_LABEL,
    MINIMAX_API_KEY_ENV,
    PERMISSION_MODE_ENV,
    IKnowEvalStateUnsupportedError,
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
