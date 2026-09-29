"""Pure parsing of the `iknow ask --json` output stream. No I/O, no harbor imports.

`iknow ask` prints one pretty-printed JSON object (src/cli/format.ts
`formatRunJson`) on stdout for a completed run and a compact JSON error envelope
on stderr for the failure paths; both channels reach us merged because the
adapter runs the command with `2>&1`. Parsing therefore scans for balanced
top-level objects rather than assuming the whole stream is JSON, and the
`trace` key is deliberately never read — it can carry the whole conversation.
"""

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Literal

PayloadKind = Literal["answer", "error_envelope", "none"]

_ANSWER_MARKER_KEYS = ("finalText", "stopReason")
# How far past a `{` the open-token lookahead may walk over whitespace.
_LOOKAHEAD_LIMIT = 64
_USAGE_KEYS = (
    "inputTokens",
    "outputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
)


@dataclass(frozen=True)
class TokenUsage:
    """One `lastUsage` reading. `None` = the key was absent or not an integer.

    `iknow ask` reports the usage of the *last* model call only
    (RunResult.lastUsage); it is not a run total.
    """

    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_read_input_tokens: int | None = None
    cache_creation_input_tokens: int | None = None


@dataclass(frozen=True)
class ParsedRun:
    """Classified ask output. `kind` selects which fields are meaningful.

    `run_state` is iknow's own name for the posture it executed in
    (`runState="eval_state"`, ADR-0130 §5); `None` means the payload did not name
    one, which is what a non-eval-state answer looks like.
    """

    kind: PayloadKind
    final_text: str | None = None
    stop_reason: str | None = None
    turn_count: int | None = None
    usage: TokenUsage | None = None
    error_code: str | None = None
    error_message: str | None = None
    run_state: str | None = None


def parse_iknow_ask_output(output: str) -> ParsedRun:
    """Parse merged ask output into a ParsedRun; never raises on bad input."""
    payloads = _json_objects(output)
    answer = _last_payload(payloads, _is_answer)
    if answer is not None:
        return _answer_run(answer)
    envelope = _last_payload(payloads, _is_error_envelope)
    if envelope is not None:
        return _envelope_run(envelope)
    return ParsedRun(kind="none")


def _is_answer(payload: dict[str, Any]) -> bool:
    return any(key in payload for key in _ANSWER_MARKER_KEYS)


def _is_error_envelope(payload: dict[str, Any]) -> bool:
    return isinstance(payload.get("error"), str)


def _last_payload(
    payloads: list[dict[str, Any]], predicate: Callable[[dict[str, Any]], bool]
) -> dict[str, Any] | None:
    for payload in reversed(payloads):
        if predicate(payload):
            return payload
    return None


def _answer_run(payload: dict[str, Any]) -> ParsedRun:
    return ParsedRun(
        kind="answer",
        final_text=_opt_str(payload.get("finalText")),
        stop_reason=_opt_str(payload.get("stopReason")),
        turn_count=_opt_int(payload.get("turnCount")),
        usage=_usage(payload.get("lastUsage")),
        run_state=_opt_str(payload.get("runState")),
    )


def _envelope_run(payload: dict[str, Any]) -> ParsedRun:
    # `error` / `message` / `turnsRan` only: the maxTurns envelope also carries a
    # `stopSummary` and the llm_mode envelope a raw apiKey, neither of which may
    # be copied into logs or context.
    return ParsedRun(
        kind="error_envelope",
        error_code=_opt_str(payload.get("error")),
        error_message=_opt_str(payload.get("message")),
        turn_count=_opt_int(payload.get("turnsRan")),
    )


def _usage(raw: Any) -> TokenUsage | None:
    if not isinstance(raw, dict):
        return None
    readings = [_opt_int(raw.get(key)) for key in _USAGE_KEYS]
    if all(value is None for value in readings):
        return None
    return TokenUsage(*readings)


def _opt_str(value: Any) -> str | None:
    return value if isinstance(value, str) else None


def _opt_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value


def _json_objects(text: str) -> list[dict[str, Any]]:
    """Every top-level JSON object in `text`, in order; malformed ones dropped.

    Brackets are counted together, so an object nested in an array is not
    mistaken for a top-level payload.

    The anchor is revocable. Because stderr is merged into stdout (`2>&1`), a
    free-form iknow notice carrying a bare `{` would otherwise pin the slice
    there, nest the real answer's braces inside a brace that never closes, and
    report a run that answered as no output at all. So the `{` that opens a
    candidate is only kept while the candidate still *looks* like a JSON object
    (see `_opens_a_json_object`); a brace that cannot is a notice, not a
    payload, and the anchor moves on. Nothing here reads the noise's text, so
    this is a property of the JSON grammar rather than of any one message.
    """
    objects: list[dict[str, Any]] = []
    depth = 0
    start = -1
    in_string = False
    escaped = False
    for index, char in enumerate(text):
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            if not _opens_a_json_object(text, index):
                continue
            if depth == 0:
                start = index
            depth += 1
        elif char == "[":
            depth += 1
        elif char in "}]":
            depth = max(depth - 1, 0)
            if depth == 0 and start != -1:
                objects.extend(_decode_object(text[start : index + 1]))
                start = -1
    return objects


def _opens_a_json_object(text: str, brace: int) -> bool:
    """Whether the `{` at `brace` is followed by a JSON object's first token.

    A JSON object opens with `{` and then either a member string or the closing
    `}`, optionally across whitespace. Anything else — a newline before another
    brace, a bare word, the end of input — means the brace belongs to the prose
    around the payload, not to a payload.

    The lookahead stops at the first non-whitespace character and is bounded, so
    each brace costs O(1) and the whole scan stays linear; the bound is only
    needed because an attacker-shaped stream could otherwise hold a brace open
    across a run of whitespace.
    """
    limit = min(len(text), brace + 1 + _LOOKAHEAD_LIMIT)
    for index in range(brace + 1, limit):
        char = text[index]
        if char.isspace():
            continue
        return char in '"}'
    return False


def _decode_object(candidate: str) -> list[dict[str, Any]]:
    try:
        payload = json.loads(candidate)
    except ValueError:
        return []
    return [payload] if isinstance(payload, dict) else []
