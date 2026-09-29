import json

import pytest

from iknow_harbor.ask_output import parse_iknow_ask_output

ASK_JSON = {
    "finalText": "done",
    "stopReason": "completed",
    "turnCount": 2,
    "lastUsage": {
        "inputTokens": 9389,
        "outputTokens": 12,
        "cacheCreationInputTokens": 0,
        "cacheReadInputTokens": 186,
    },
    "trace": {"turns": [{"toolCalls": [{"toolName": "bash"}]}]},
}

# Verbatim from `iknow ask` on the host with a valid route and no key.
API_KEY_ENVELOPE = (
    '{"error":"llm_provider_api_key_missing","code":"provider_api_key_missing",'
    '"provider":"minimax-cn","apiKeyEnv":"MINIMAX_API_KEY","message":'
    '"provider_api_key_missing: minimax-cn (env MINIMAX_API_KEY unset)"}'
)


def ask_stdout(payload: dict) -> str:
    return json.dumps(payload, indent=2) + "\n"


class TestAnswerPayload:
    def test_valid_json_carries_the_non_trace_keys(self):
        parsed = parse_iknow_ask_output(ask_stdout(ASK_JSON))

        assert parsed.kind == "answer"
        assert parsed.final_text == "done"
        assert parsed.stop_reason == "completed"
        assert parsed.turn_count == 2
        assert parsed.usage is not None
        assert parsed.usage.input_tokens == 9389
        assert parsed.usage.output_tokens == 12
        assert parsed.usage.cache_read_input_tokens == 186
        assert parsed.usage.cache_creation_input_tokens == 0

    def test_compact_single_line_json(self):
        parsed = parse_iknow_ask_output(json.dumps(ASK_JSON))

        assert parsed.kind == "answer"
        assert parsed.turn_count == 2

    def test_the_key_set_is_unnamed_when_runState_is_absent(self):
        # src/cli/format.ts drops the key for every posture but eval state, so a
        # missing key is the normal case, not a parse failure.
        parsed = parse_iknow_ask_output(ask_stdout(ASK_JSON))

        assert parsed.run_state is None

    def test_eval_state_names_its_own_run(self):
        payload = {**ASK_JSON, "runState": "eval_state"}

        parsed = parse_iknow_ask_output(ask_stdout(payload))

        assert parsed.run_state == "eval_state"

    def test_braces_inside_strings_do_not_split_the_object(self):
        payload = {**ASK_JSON, "finalText": 'echo {"a": 1} && done'}

        parsed = parse_iknow_ask_output(ask_stdout(payload))

        assert parsed.final_text == 'echo {"a": 1} && done'

    def test_json_after_stderr_noise_is_still_found(self):
        output = f"错误: transport closed\n{ask_stdout(ASK_JSON)}\n"

        parsed = parse_iknow_ask_output(output)

        assert parsed.kind == "answer"
        assert parsed.usage is not None

    def test_unmatched_open_brace_in_leading_noise_does_not_swallow_the_answer(self):
        # iknow writes free-form stderr on the ask path (`EVAL_STATE_NOTICE`,
        # `[violation] session killed: ...`, the lsp / memory / subagent
        # notices), and agent.py merges the streams with `2>&1`. A bare `{` in
        # one of those lines used to pin the slice anchor there, so the answer
        # nested inside a brace that can never close and a run that answered
        # scored as no output at all.
        noise = "[eval-state] sandbox retired\nrunning: {\n"

        parsed = parse_iknow_ask_output(noise + ask_stdout(ASK_JSON))

        assert parsed.kind == "answer"
        assert parsed.final_text == "done"
        assert parsed.usage is not None
        assert parsed.usage.input_tokens == 9389

    def test_unmatched_open_brace_in_trailing_noise_keeps_the_answer(self):
        noise = "[eval-state] sandbox retired\nrunning: {\n"

        parsed = parse_iknow_ask_output(ask_stdout(ASK_JSON) + noise)

        assert parsed.kind == "answer"
        assert parsed.final_text == "done"

    def test_unmatched_close_brace_in_noise_keeps_the_answer(self):
        noise = "错误: transport closed: }\n"

        parsed = parse_iknow_ask_output(noise + ask_stdout(ASK_JSON))

        assert parsed.kind == "answer"
        assert parsed.final_text == "done"

    def test_a_nested_payload_under_a_noise_brace_is_still_found(self):
        noise = "stream noise: {\n"

        parsed = parse_iknow_ask_output(
            noise + json.dumps(ASK_JSON) + "} trailing garbage\n"
        )

        assert parsed.kind == "answer"
        assert parsed.final_text == "done"

    def test_last_answer_wins_when_a_turn_is_printed_twice(self):
        first = {**ASK_JSON, "finalText": "first"}
        second = {**ASK_JSON, "finalText": "second"}

        parsed = parse_iknow_ask_output(ask_stdout(first) + ask_stdout(second))

        assert parsed.final_text == "second"


class TestUsageIsTolerant:
    def test_missing_last_usage_yields_no_usage(self):
        payload = {k: v for k, v in ASK_JSON.items() if k != "lastUsage"}

        parsed = parse_iknow_ask_output(ask_stdout(payload))

        assert parsed.kind == "answer"
        assert parsed.usage is None

    def test_partial_last_usage_keeps_the_read_fields(self):
        payload = {**ASK_JSON, "lastUsage": {"inputTokens": 10, "outputTokens": 3}}

        parsed = parse_iknow_ask_output(ask_stdout(payload))

        assert parsed.usage is not None
        assert parsed.usage.input_tokens == 10
        assert parsed.usage.cache_read_input_tokens is None

    def test_null_usage_fields_stay_none(self):
        payload = {**ASK_JSON, "lastUsage": {"inputTokens": None, "outputTokens": 7}}

        parsed = parse_iknow_ask_output(ask_stdout(payload))

        assert parsed.usage is not None
        assert parsed.usage.input_tokens is None
        assert parsed.usage.output_tokens == 7

    def test_non_numeric_usage_field_is_dropped(self):
        payload = {
            **ASK_JSON,
            "lastUsage": {"inputTokens": "9389", "outputTokens": 5},
        }

        parsed = parse_iknow_ask_output(ask_stdout(payload))

        assert parsed.usage is not None
        assert parsed.usage.input_tokens is None
        assert parsed.usage.output_tokens == 5

    def test_a_last_usage_of_only_unusable_readings_is_no_usage(self):
        payload = {**ASK_JSON, "lastUsage": {"inputTokens": "9389"}}

        parsed = parse_iknow_ask_output(ask_stdout(payload))

        assert parsed.usage is None

    def test_null_final_text_is_not_turned_into_a_string(self):
        parsed = parse_iknow_ask_output(ask_stdout({**ASK_JSON, "finalText": None}))

        assert parsed.kind == "answer"
        assert parsed.final_text is None


class TestUnparsableOutput:
    @pytest.mark.parametrize("output", ["", "   \n", "no json here at all"])
    def test_empty_and_noise_only_output(self, output: str):
        parsed = parse_iknow_ask_output(output)

        assert parsed.kind == "none"
        assert parsed.final_text is None
        assert parsed.usage is None

    def test_truncated_json_is_not_rescued(self):
        parsed = parse_iknow_ask_output('{"finalText": "yes", "turnCount": 2')

        assert parsed.kind == "none"

    def test_object_wrapped_in_an_array_is_not_top_level_payload(self):
        parsed = parse_iknow_ask_output('[{"finalText": "x", "stopReason": "y"}]')

        assert parsed.kind == "none"


class TestErrorEnvelopes:
    def test_max_turns_envelope_from_a_non_zero_exit(self):
        envelope = {
            "error": "max_turns_exceeded",
            "turnsRan": 20,
            "reason": "max_turns",
            "message": "已达 maxTurns=20 轮上限，终止",
        }

        parsed = parse_iknow_ask_output(json.dumps(envelope))

        assert parsed.kind == "error_envelope"
        assert parsed.error_code == "max_turns_exceeded"
        assert parsed.error_message == "已达 maxTurns=20 轮上限，终止"
        assert parsed.turn_count == 20

    def test_the_observed_key_envelope_is_an_error_run(self):
        parsed = parse_iknow_ask_output(API_KEY_ENVELOPE)

        assert parsed.kind == "error_envelope"
        assert parsed.error_code == "llm_provider_api_key_missing"
        assert parsed.turn_count is None

    def test_envelope_side_fields_are_not_carried_into_the_run(self):
        envelope = {
            "error": "llm_mode",
            "apiKey": "sk-secret",
            "stopSummary": "the whole conversation",
            "message": "provider rejected the request",
        }

        parsed = parse_iknow_ask_output(json.dumps(envelope))

        assert parsed.error_message == "provider rejected the request"
        assert parsed.final_text is None
        assert parsed.turn_count is None

    def test_answer_beats_an_earlier_envelope(self):
        output = json.dumps({"error": "noise"}) + "\n" + ask_stdout(ASK_JSON)

        assert parse_iknow_ask_output(output).kind == "answer"
