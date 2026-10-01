"""Benchmark failure attribution (spec #1170, SC13), computed offline.

Three labels, defined by the spec and by nothing else in this file:

1. ``harness_induced_block`` — **causal evidence** shows a false denial or a
   runtime/cleanup fault prevented task completion.
2. ``model_or_policy`` — evidence shows model noncompletion/wrong answer, or a
   real confirmed security violation.
3. ``unknown_or_mixed`` — evidence is insufficient, conflicting, or points to
   evaluator/environment effects that cannot be separated confidently.

**What this module structurally cannot do.** It never derives a label from the
trace. The trace is read into :class:`TraceFacts` and carried as evidence
*about* the run; the decision consumes :class:`CausalEvidence`, which a person
must construct, name a reviewer for, and point at a reference. Every field a
:class:`CausalEvidence` could plausibly be filled from automatically — a
``tool_call`` cause, a cleanup state, a ``violation`` row, a turn cap — is
listed in :data:`NON_CAUSAL_EVIDENCE_KINDS` and rejected at construction, so
there is no string a caller can pass that turns "a deny happened" into causal
evidence. This is the mechanical form of the spec's "a deny alone does not
prove harness causation" and "trace records facts, not verdicts".

The raw outcome is read and copied, never recomputed and never written.
:func:`read_trial` opens the artifacts read-only, and :func:`build_report`
carries ``raw`` through untouched, so a harness-attributed failure remains in
the benchmark's failure total. Nothing here edits a ``result.json``, a
``reward.txt`` or a trace file.
"""

from __future__ import annotations

import json
import os
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, replace
from typing import Any, Final, Literal, NamedTuple

AttributionLabel = Literal[
    "harness_induced_block",
    "model_or_policy",
    "unknown_or_mixed",
]

HARNESS_BLOCK: Final = "harness_induced_block"
MODEL_OR_POLICY: Final = "model_or_policy"
UNKNOWN_OR_MIXED: Final = "unknown_or_mixed"

ALL_LABELS: Final = (HARNESS_BLOCK, MODEL_OR_POLICY, UNKNOWN_OR_MIXED)

#: Evidence kinds that assert *causation*. A label is derived from these and
#: from nothing else, so the trace — which can only ever supply the kinds
#: below — cannot reach a decision on its own.
HARNESS_CAUSAL_KINDS: Final = frozenset(
    {
        "false_denial_prevented_completion",
        "runtime_fault_prevented_completion",
        "cleanup_fault_prevented_completion",
    }
)
MODEL_CAUSAL_KINDS: Final = frozenset(
    {
        "model_noncompletion",
        "wrong_answer",
        "confirmed_security_violation",
    }
)
CAUSAL_EVIDENCE_KINDS: Final = HARNESS_CAUSAL_KINDS | MODEL_CAUSAL_KINDS

#: Observation names that a trace row can carry. They are recorded as facts and
#: are refused if anyone offers them *as* the causal evidence, so "the trace
#: says a deny happened" can never be laundered into "therefore the harness
#: blocked the task".
NON_CAUSAL_EVIDENCE_KINDS: Final = frozenset(
    {
        "deny_observed",
        "hard_wall_deny",
        "timeout_observed",
        "cleanup_unconfirmed",
        "turn_cap_reached",
        "security_interruption_observed",
        "violation_observed",
        "reward_written",
        "tests_did_not_run",
    }
)

#: Evidence kinds whose finding is about the evaluator or the environment
#: rather than about the harness or the model. Recorded, never auto-applied:
#: whether such a fault is separable from the run is a reviewer's judgement.
EVALUATOR_EFFECT_KINDS: Final = frozenset(
    {
        "evaluator_fault",
        "environment_fault",
        "verifier_never_ran",
    }
)

#: The three markers the pilot report used to decide a verifier never reached
#: its tests. Recorded verbatim here so the fact is computed, not re-typed.
BROKEN_VERIFIER_MARKERS: Final = (
    "uvx: command not found",
    "Failed to connect",
    "Connection timed out",
    "network timeout",
    "No such file or directory",
)

_PYTEST_SUMMARY: Final = re.compile(
    r"^\d+ (?:passed|failed|error|errors|skipped)(?:,\s*\d+ \w+)* in [\d.]+s",
    re.MULTILINE,
)

#: Pilot comparison discipline: one trial per task is not a comparison.
MIN_REPETITIONS_PER_TASK: Final = 2

#: Pins a before/after comparison must carry, checked against the declared
#: set so a partially-specified comparison is refused rather than run.
REQUIRED_PINS: Final = ("model", "dataset", "permission_mode", "max_turns")

#: The pins a per-trial artifact always carries, so a trial that records
#: nothing for one of them is a hole in the evidence rather than a
#: job-config setting that merely lives elsewhere. The other three
#: (`--model`, `-d`, `--ak max_turns`) are harbor job-config settings; a
#: comparison declares them and the reported ``unverified_pins`` says the
#: artifacts did not corroborate them.
ARTIFACT_RECORDED_PINS: Final = ("permission_mode",)


class TrialArtifactError(RuntimeError):
    """A trial directory is missing, unreadable, or not the shape it claims."""


class TrialArtifacts(NamedTuple):
    """What one trial directory holds. Named so callers may unpack or read a field."""

    raw: RawOutcome
    facts: TraceFacts | None


class NonCausalEvidenceError(ValueError):
    """A trace observation was offered as the causal evidence for a label."""


class ConflictingPinError(ValueError):
    """A comparison's pinned conditions do not hold across its trials."""


class InsufficientRepetitionError(ConflictingPinError):
    """A comparison has too few repeated trials per task to be a comparison."""


# ---------------------------------------------------------------------------
# Evidence
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CausalEvidence:
    """One human-supplied causal finding, with the person who made it.

    Every field is load-bearing:

    - ``kind`` must be one of :data:`CAUSAL_EVIDENCE_KINDS`. The observation
      kinds in :data:`NON_CAUSAL_EVIDENCE_KINDS` are rejected here rather than
      downgraded, because a "harness induced" label must be *earned* by a
      causal claim and no other construction may produce one.
    - ``reviewed_by`` is a named person. An unattributed finding has nobody
      standing behind it, so it is not evidence.
    - ``reference`` points at the artifact the finding rests on, so a reader
      can re-check it. The reference is carried into the report unchanged; it
      is never resolved or validated against a file, because a finding may
      cite a reviewer's note that this tool has no way to open.
    """

    kind: str
    detail: str
    reference: str
    reviewed_by: str

    def __post_init__(self) -> None:
        if self.kind in NON_CAUSAL_EVIDENCE_KINDS:
            raise NonCausalEvidenceError(
                f"{self.kind!r} is an observation the trace already records, not "
                "causal evidence. Name what prevented completion and who "
                "established it; 'the trace shows a deny' cannot establish that "
                "the deny caused the failure."
            )
        if (
            self.kind not in CAUSAL_EVIDENCE_KINDS
            and self.kind not in EVALUATOR_EFFECT_KINDS
        ):
            raise ValueError(
                f"unknown evidence kind {self.kind!r}; expected one of "
                f"{sorted(CAUSAL_EVIDENCE_KINDS | EVALUATOR_EFFECT_KINDS)}"
            )
        for name, value in (("reviewed_by", self.reviewed_by),
                            ("reference", self.reference),
                            ("detail", self.detail)):
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"causal evidence needs a non-empty {name}")

    @property
    def side(self) -> str | None:
        """``"harness"``, ``"model"`` or ``None`` when the kind decides neither."""
        if self.kind in HARNESS_CAUSAL_KINDS:
            return "harness"
        if self.kind in MODEL_CAUSAL_KINDS:
            return "model"
        return None


@dataclass(frozen=True)
class AttributionRequest:
    """The human act that authorizes an attribution pass.

    ``reviewer`` names who is performing it. ``evidence`` is the causal material
    they are supplying. There is deliberately no flag that says "infer it from
    the trace": the whole decision rests on the absence of one.
    """

    reviewer: str
    evidence: Sequence[CausalEvidence] = ()
    note: str | None = None

    def __post_init__(self) -> None:
        if not isinstance(self.reviewer, str) or not self.reviewer.strip():
            raise ValueError(
                "an attribution pass must name its reviewer; an unattributed "
                "label is not evidence"
            )

    @property
    def references(self) -> tuple[str, ...]:
        return tuple(item.reference for item in self.evidence)


# ---------------------------------------------------------------------------
# Artifacts
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TrialPins:
    """The comparison conditions a single trial actually ran under.

    Fields the artifacts do not record stay ``None``. A guess would be
    indistinguishable from a measurement, and SC13 asks a comparison to *pin*
    its conditions.
    """

    task_name: str
    trial_name: str
    permission_mode: str | None = None
    eval_state: bool | None = None
    model: str | None = None
    dataset: str | None = None
    max_turns: int | None = None


@dataclass(frozen=True)
class RawOutcome:
    """The benchmark's own verdict for one trial, exactly as its artifacts say.

    Nothing in this module recomputes or revises these fields.
    """

    task_name: str
    trial_name: str
    reward: float | None
    passed: bool | None
    ctrf_present: bool
    tests_executed: bool
    pytest_summary: str | None
    broken_verifier_markers: tuple[str, ...]
    exception_type: str | None
    turn_count: int | None
    turn_cap_reached: bool
    stop_reason: str | None
    trace_evidence_state: str | None
    trace_write_failed: bool
    trace_conversation_id: str | None
    pins: TrialPins


@dataclass(frozen=True)
class TraceFacts:
    """What the run's own trace recorded. Observations, never conclusions."""

    conversation_id: str | None
    record_count: int
    denied_tool_calls: int
    denied_commands: tuple[str, ...]
    timed_out_tool_calls: int
    cancelled_tool_calls: int
    unconfirmed_cleanup_tool_calls: int
    confirmed_stopped_tool_calls: int
    security_interruptions: int
    confirmed_violations: int
    unconfirmed_cleanup_items: int
    turn_caps: int
    turns: int
    trace_file: str | None

    @property
    def causal(self) -> bool:
        """Whether this trace holds any observation at all.

        Present so a caller cannot treat "no facts" and "facts that decide
        nothing" as the same thing; it is never consulted by the decision.
        """
        return self.record_count > 0


@dataclass(frozen=True)
class AttributedTrial:
    """One trial's raw outcome, its trace facts, and exactly one label."""

    raw: RawOutcome
    label: AttributionLabel
    rationale: str
    evidence_references: tuple[str, ...]
    facts: TraceFacts | None
    reviewer: str
    note: str | None = None

    def to_json(self) -> dict[str, Any]:
        return {
            "raw": {
                "task_name": self.raw.task_name,
                "trial_name": self.raw.trial_name,
                "reward": self.raw.reward,
                "passed": self.raw.passed,
                "tests_executed": self.raw.tests_executed,
                "pytest_summary": self.raw.pytest_summary,
                "broken_verifier_markers": list(
                    self.raw.broken_verifier_markers
                ),
                "exception_type": self.raw.exception_type,
                "turn_count": self.raw.turn_count,
                "turn_cap_reached": self.raw.turn_cap_reached,
                "stop_reason": self.raw.stop_reason,
                "trace_evidence_state": self.raw.trace_evidence_state,
                "trace_write_failed": self.raw.trace_write_failed,
            },
            "label": self.label,
            "rationale": self.rationale,
            "evidence_references": list(self.evidence_references),
            "reviewer": self.reviewer,
            "note": self.note,
            "trace_facts": None
            if self.facts is None
            else {
                "conversation_id": self.facts.conversation_id,
                "record_count": self.facts.record_count,
                "denied_tool_calls": self.facts.denied_tool_calls,
                "denied_commands": list(self.facts.denied_commands),
                "timed_out_tool_calls": self.facts.timed_out_tool_calls,
                "cancelled_tool_calls": self.facts.cancelled_tool_calls,
                "unconfirmed_cleanup_tool_calls": (
                    self.facts.unconfirmed_cleanup_tool_calls
                ),
                "confirmed_stopped_tool_calls": (
                    self.facts.confirmed_stopped_tool_calls
                ),
                "security_interruptions": self.facts.security_interruptions,
                "confirmed_violations": self.facts.confirmed_violations,
                "unconfirmed_cleanup_items": self.facts.unconfirmed_cleanup_items,
                "turn_caps": self.facts.turn_caps,
                "turns": self.facts.turns,
                "trace_file": self.facts.trace_file,
            },
        }


@dataclass(frozen=True)
class RawTally:
    """The benchmark's own numbers over every trial, attributed or not."""

    total_trials: int
    passes: int
    failures: int
    no_outcome: int
    reward_sum: float

    @property
    def scored_trials(self) -> int:
        return self.passes + self.failures


@dataclass(frozen=True)
class AttributionReport:
    """Attribution *beside* the raw score, never instead of it."""

    trials: tuple[AttributedTrial, ...]
    raw: RawTally
    label_counts: dict[str, int]

    @property
    def is_attributed_subset_the_score(self) -> bool:
        """False by construction, and asserted as such.

        The report carries the whole raw set; the attributed subset is a
        separate count over the same trials, so a reader who divides the
        attributed passes by the trial count is reading a number this object
        never exposes as a score.
        """
        return False

    def to_json(self) -> dict[str, Any]:
        return {
            "raw": {
                "total_trials": self.raw.total_trials,
                "passes": self.raw.passes,
                "failures": self.raw.failures,
                "no_outcome": self.raw.no_outcome,
                "reward_sum": self.raw.reward_sum,
            },
            "attribution_is_supplementary": True,
            "label_counts": dict(self.label_counts),
            "trials": [trial.to_json() for trial in self.trials],
        }


@dataclass(frozen=True)
class ComparisonPins:
    """The conditions a before/after comparison declares.

    Declared, not discovered: the artifacts do not carry a dataset version or a
    model id, so the caller states them and :func:`verify_pins` checks which of
    them the trial artifacts corroborate.
    """

    model: str
    dataset: str
    permission_mode: str
    max_turns: int
    eval_state: bool

    def as_tuple(self) -> tuple[Any, ...]:
        return (
            self.model,
            self.dataset,
            self.permission_mode,
            self.max_turns,
            self.eval_state,
        )


@dataclass(frozen=True)
class PinnedReport:
    """An attribution report that has passed :func:`verify_pins`."""

    report: AttributionReport
    pins: ComparisonPins
    unverified_pins: tuple[str, ...]
    repetitions: dict[str, int]

    @property
    def raw(self) -> RawTally:
        return self.report.raw

    @property
    def label_counts(self) -> dict[str, int]:
        return self.report.label_counts

    def _replace(self, **changes: Any) -> "PinnedReport":
        return replace(self, **changes)


@dataclass(frozen=True)
class RunComparison:
    """A before/after pair, both raw totals and both pinned sets visible."""

    before: PinnedReport
    after: PinnedReport

    def to_json(self) -> dict[str, Any]:
        return {
            "pins": _pins_json(self.before.pins),
            "before": self.before.report.to_json(),
            "after": self.after.report.to_json(),
            "repetitions": {
                "before": self.before.repetitions,
                "after": self.after.repetitions,
            },
        }


# ---------------------------------------------------------------------------
# Reading artifacts (read-only)
# ---------------------------------------------------------------------------


def read_trial(path: str) -> TrialArtifacts:
    """Read one Harbor trial directory into its raw outcome and trace facts.

    Opens every file for reading only. A missing ``result.json``, or one that
    is not JSON, raises :class:`TrialArtifactError` rather than yielding a
    trial with a guessed outcome.
    """
    result_path = os.path.join(path, "result.json")
    result = _read_json(result_path)

    metadata = result.get("agent_result")
    metadata = metadata.get("metadata") if isinstance(metadata, dict) else None
    metadata = metadata if isinstance(metadata, dict) else {}

    task_name = result.get("task_name")
    trial_name = result.get("trial_name")
    if not isinstance(task_name, str) or not isinstance(trial_name, str):
        raise TrialArtifactError(
            f"{result_path} does not name a task and a trial"
        )

    reward = _read_reward(os.path.join(path, "verifier", "reward.txt"))
    ctrf = _read_optional_json(
        os.path.join(path, "verifier", "ctrf.json")
    )
    stdout = _read_optional_text(
        os.path.join(path, "verifier", "test-stdout.txt")
    )

    pytest_summary = None
    if stdout:
        match = _PYTEST_SUMMARY.search(stdout)
        if match:
            pytest_summary = match.group(0).strip()
    markers = tuple(
        marker for marker in BROKEN_VERIFIER_MARKERS if stdout and marker in stdout
    )
    tests_executed = ctrf is not None and pytest_summary is not None

    exception = result.get("exception_info")
    exception_type = (
        exception.get("exception_type")
        if isinstance(exception, dict)
        else None
    )
    if not isinstance(exception_type, str):
        exception_type = None

    turn_count = _opt_int(metadata.get("turn_count"))
    stop_reason = _opt_str(metadata.get("stop_reason"))
    error_code = _opt_str(metadata.get("iknow_error"))
    turn_cap_reached = (
        stop_reason == "max_turns_exceeded"
        or error_code == "max_turns_exceeded"
    )

    pins = TrialPins(
        task_name=task_name,
        trial_name=trial_name,
        permission_mode=_opt_str(metadata.get("permission_mode")),
        eval_state=(
            metadata.get("eval_state")
            if isinstance(metadata.get("eval_state"), bool)
            else None
        ),
        model=_opt_str(metadata.get("model")),
        dataset=_opt_str(metadata.get("dataset")),
        max_turns=_opt_int(metadata.get("max_turns")),
    )

    raw = RawOutcome(
        task_name=task_name,
        trial_name=trial_name,
        reward=reward,
        passed=None if reward is None else reward >= 1.0,
        ctrf_present=ctrf is not None,
        tests_executed=tests_executed,
        pytest_summary=pytest_summary,
        broken_verifier_markers=markers,
        exception_type=exception_type,
        turn_count=turn_count,
        turn_cap_reached=turn_cap_reached,
        stop_reason=stop_reason,
        trace_evidence_state=_opt_str(metadata.get("trace_state")),
        trace_write_failed=bool(metadata.get("trace_write_failed")),
        trace_conversation_id=_opt_str(
            metadata.get("trace_conversation_id")
        ),
        pins=pins,
    )

    facts = None
    trace_path = _resolve_trace_path(path, metadata)
    if trace_path is not None:
        facts = read_trace(trace_path, metadata.get("trace_conversation_id"))

    return TrialArtifacts(raw=raw, facts=facts)


def read_trace(path: str, expected_conversation_id: Any = None) -> TraceFacts:
    """Parse one JSONL trace into observations. Malformed lines are skipped.

    A truncated final line is what a run that died mid-write leaves behind, so
    dropping it is the right reading rather than an error; the surviving rows
    are still facts, and the raw count they support is what the trial reported.
    """
    rows: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                parsed = json.loads(line)
            except ValueError:
                continue
            if isinstance(parsed, dict):
                rows.append(parsed)

    conversation_id = _opt_str(expected_conversation_id)
    if conversation_id is None:
        for row in rows:
            conversation_id = _opt_str(row.get("conversation_id"))
            if conversation_id is not None:
                break

    denied = [row for row in rows if _is_denial(row)]
    unconfirmed_items = 0
    for row in rows:
        for item in row.get("cleanup") or ():
            if isinstance(item, dict) and item.get("state") == "unconfirmed":
                unconfirmed_items += 1

    return TraceFacts(
        conversation_id=conversation_id,
        record_count=len(rows),
        denied_tool_calls=len(denied),
        denied_commands=tuple(
            command
            for command in (_denied_command(row) for row in denied)
            if command is not None
        ),
        timed_out_tool_calls=sum(
            1 for row in rows if row.get("cause") == "timeout"
        ),
        cancelled_tool_calls=sum(
            1 for row in rows if row.get("cause") == "cancelled"
        ),
        unconfirmed_cleanup_tool_calls=sum(
            1 for row in rows if _tool_cleanup_state(row) == "unconfirmed"
        ),
        confirmed_stopped_tool_calls=sum(
            1 for row in rows if _tool_cleanup_state(row) == "confirmed_stopped"
        ),
        security_interruptions=sum(
            1
            for row in rows
            if row.get("record_type") == "violation"
            and "cleanup" in row
        ),
        confirmed_violations=max(
            [
                row["confirmed_violations"]
                for row in rows
                if isinstance(row.get("confirmed_violations"), int)
                and not isinstance(row.get("confirmed_violations"), bool)
            ]
            or [0]
        ),
        unconfirmed_cleanup_items=unconfirmed_items,
        turn_caps=sum(
            1
            for row in rows
            if row.get("record_type") == "turn"
            and row.get("decision") == "max_turns"
        ),
        turns=sum(1 for row in rows if row.get("record_type") == "turn"),
        trace_file=path,
    )


# ---------------------------------------------------------------------------
# The decision
# ---------------------------------------------------------------------------


def attribute_trial(
    trial: tuple[RawOutcome, TraceFacts | None], request: AttributionRequest
) -> AttributedTrial:
    """Label one trial from its raw outcome, its facts, and the reviewer's evidence.

    The only inputs to the label are ``request.evidence`` and the raw outcome's
    own verdict. ``facts`` never reaches this function's decision branches — it
    is attached to the result so a reader can see what the run recorded.
    """
    raw, facts = trial
    # `None` is kept deliberately: an evaluator/environment finding sits
    # alongside a causal one, and dropping it here would let the causal
    # finding win a comparison it should not have to win.
    sides = {item.side for item in request.evidence}
    references = tuple(dict.fromkeys(item.reference for item in request.evidence))

    label, rationale = _decide(raw, request, sides)
    return AttributedTrial(
        raw=raw,
        label=label,
        rationale=rationale,
        evidence_references=references,
        facts=facts,
        reviewer=request.reviewer,
        note=request.note,
    )


def _decide(
    raw: RawOutcome,
    request: AttributionRequest,
    sides: set[str | None],
) -> tuple[AttributionLabel, str]:
    if not request.evidence:
        return UNKNOWN_OR_MIXED, (
            "no causal evidence was supplied: the trial keeps its raw verdict "
            "and the trace's observations (denials, timeouts, turn caps, "
            "cleanup state) are facts that do not decide anything on their own"
        )

    if sides == {"harness", "model"}:
        return UNKNOWN_OR_MIXED, (
            "conflicting causal evidence: the supplied findings point at both "
            "the harness and the model, so the failure cannot be attributed "
            "to either"
        )

    if None in sides and len(sides) > 1:
        return UNKNOWN_OR_MIXED, (
            "the supplied findings name an evaluator or environment effect "
            "alongside a causal one, and the two cannot be separated "
            "confidently from each other"
        )

    if sides == {"harness"}:
        if raw.passed is True:
            return UNKNOWN_OR_MIXED, (
                "the raw trial is passing: causal evidence that something "
                "blocked completion does not apply to a trial the verifier "
                "accepted"
            )
        return HARNESS_BLOCK, (
            "a named reviewer found causal evidence that a false denial or a "
            "runtime/cleanup fault prevented completion"
        )

    if sides == {"model"}:
        if raw.passed is True:
            return UNKNOWN_OR_MIXED, (
                "the raw trial is passing: the verifier accepted it, so no "
                "model-causal finding applies to it"
            )
        return MODEL_OR_POLICY, (
            "a named reviewer found causal evidence of model "
            "noncompletion/wrong answer, or of a confirmed security violation"
        )

    return UNKNOWN_OR_MIXED, (
        "the supplied evidence attributes the failure to an evaluator or "
        "environment effect, or to nothing that separates it confidently from "
        "the harness or the model"
    )


def attribute_trials(
    paths: Iterable[str], request: AttributionRequest
) -> tuple[AttributedTrial, ...]:
    """Label each trial directory in `paths`, preserving the given order."""
    return tuple(
        attribute_trial(read_trial(path), request) for path in paths
    )


def build_report(trials: Iterable[AttributedTrial]) -> AttributionReport:
    """Tally the raw outcomes and the labels separately.

    The raw tally counts every trial, and the label counts are a second tally
    over the same list. Nothing filters the raw set — in particular an
    ``harness_induced_block`` trial is still a failure in ``raw.failures``.
    """
    ordered = tuple(trials)
    passes = sum(1 for t in ordered if t.raw.passed is True)
    failures = sum(1 for t in ordered if t.raw.passed is False)
    no_outcome = sum(1 for t in ordered if t.raw.passed is None)
    reward_sum = sum(t.raw.reward for t in ordered if t.raw.reward is not None)
    counts = {label: 0 for label in ALL_LABELS}
    for trial in ordered:
        counts[trial.label] += 1
    return AttributionReport(
        trials=ordered,
        raw=RawTally(
            total_trials=len(ordered),
            passes=passes,
            failures=failures,
            no_outcome=no_outcome,
            reward_sum=reward_sum,
        ),
        label_counts=counts,
    )


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------


def verify_pins(
    trials: Sequence[AttributedTrial], pins: ComparisonPins
) -> PinnedReport:
    """Refuse a comparison whose pinned conditions do not hold.

    Two checks, both from the artifacts:

    1. Every pin must be declared, and every pin the artifacts *do* record
       (``permission_mode``, ``eval_state``) must match across all trials and
       agree with the declaration.
    2. Every task must have at least :data:`MIN_REPETITIONS_PER_TASK` trials.
       One trial per task is an anecdote, not a comparison.

    The pins a trial directory cannot corroborate (``model``, ``dataset``,
    ``max_turns``) are reported as ``unverified_pins`` rather than asserted.
    """
    declared = pins.as_tuple()
    if None in declared:
        missing = [
            name
            for name, value in zip(REQUIRED_PINS, declared)
            if value is None
        ]
        raise ConflictingPinError(
            "the comparison does not pin "
            + ", ".join(missing)
            + "; a before/after comparison must fix the same model, dataset "
            "version, permission mode and task budget on both sides"
        )
    if not trials:
        raise ConflictingPinError("the comparison contains no trials")

    unverified: list[str] = []
    for name, value in zip(REQUIRED_PINS, declared):
        observed = {getattr(trial.raw.pins, name) for trial in trials}
        if observed == {None}:
            # No trial records this pin at all. `model`, `dataset` and
            # `max_turns` are harbor job-config settings that no trial
            # directory carries, so this is the expected reading for them: the
            # declaration is still mandatory and is still compared across the
            # two runs, but the report says the artifacts did not corroborate
            # it. A pin the artifacts *do* carry and here carry nothing is a
            # hole in the evidence rather than a match.
            if name in ARTIFACT_RECORDED_PINS:
                raise ConflictingPinError(
                    f"{name} is pinned to {value!r} but no trial artifact "
                    f"records it, so the comparison cannot show the "
                    f"condition held"
                )
            unverified.append(name)
            continue
        if observed != {value}:
            raise ConflictingPinError(
                f"{name} is pinned to {value!r} but the trials record {sorted(observed, key=str)!r}"
            )

    eval_states = {trial.raw.pins.eval_state for trial in trials}
    if eval_states != {pins.eval_state}:
        raise ConflictingPinError(
            f"eval_state is pinned to {pins.eval_state!r} but the trials "
            f"record {sorted(eval_states, key=str)!r}"
        )

    repetitions: dict[str, int] = {}
    for trial in trials:
        name = trial.raw.task_name
        repetitions[name] = repetitions.get(name, 0) + 1
    thin = sorted(
        name for name, count in repetitions.items()
        if count < MIN_REPETITIONS_PER_TASK
    )
    if thin:
        raise InsufficientRepetitionError(
            "these tasks have fewer than "
            f"{MIN_REPETITIONS_PER_TASK} repeated trials: {', '.join(thin)}; "
            "stochastic trials must be repeated before a comparison is drawn"
        )

    return PinnedReport(
        report=build_report(trials),
        pins=pins,
        unverified_pins=tuple(unverified),
        repetitions=repetitions,
    )


def compare_runs(before: PinnedReport, after: PinnedReport) -> RunComparison:
    """Pair two verified runs. Their pins must be identical.

    Mismatched pins are the failure this refuses: a before/after read across
    two different models, datasets, modes or budgets measures the difference
    between the conditions, not the change.
    """
    if before.pins.as_tuple() != after.pins.as_tuple():
        raise ConflictingPinError(
            f"the two runs are pinned differently: {before.pins.as_tuple()!r} "
            f"vs {after.pins.as_tuple()!r}"
        )
    return RunComparison(before=before, after=after)


# ---------------------------------------------------------------------------
# Internals
# ---------------------------------------------------------------------------


def _read_json(path: str) -> dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            parsed = json.load(handle)
    except FileNotFoundError:
        raise TrialArtifactError(f"{path} does not exist") from None
    except ValueError as error:
        raise TrialArtifactError(f"{path} is not valid JSON: {error}") from None
    if not isinstance(parsed, dict):
        raise TrialArtifactError(f"{path} is not a JSON object")
    return parsed


def _read_optional_json(path: str) -> dict[str, Any] | None:
    try:
        return _read_json(path)
    except TrialArtifactError:
        return None


def _read_optional_text(path: str) -> str | None:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return None


def _read_reward(path: str) -> float | None:
    text = _read_optional_text(path)
    if text is None:
        return None
    try:
        return float(text.strip())
    except ValueError:
        return None


def _resolve_trace_path(
    path: str, metadata: dict[str, Any]
) -> str | None:
    """Find the trace this trial retained, if it retained one.

    The trial metadata names the file it observed in the container
    (``trace_file``, ``trace_conversation_id``), and harbor collects the agent
    log dir at a fixed location, so the conversation id is the join key. A
    trial with no trace file named, or whose file is not on disk, has no trace
    facts at all rather than empty ones.
    """
    conversation_id = _opt_str(metadata.get("trace_conversation_id"))
    if conversation_id is None:
        return None
    candidate = os.path.join(
        path, "artifacts", "logs", "agent", "trace", conversation_id + ".jsonl"
    )
    if os.path.isfile(candidate):
        return candidate
    return None


def _is_denial(row: dict[str, Any]) -> bool:
    if row.get("record_type") != "tool_call":
        return False
    if row.get("status") != "error":
        return False
    error = row.get("error")
    message = error.get("message") if isinstance(error, dict) else None
    return isinstance(message, str) and "[hard_wall]" in message


def _tool_cleanup_state(row: dict[str, Any]) -> str | None:
    """The cleanup state of a `tool_call` row, or None.

    A `violation` row carries a *list* of per-item cleanups; a `tool_call` row
    carries the one discriminated body. Only the latter is read here, so a
    violation's per-item states are counted separately rather than collapsed
    onto the tool-call count.
    """
    cleanup = row.get("cleanup")
    if isinstance(cleanup, dict):
        state = cleanup.get("state")
        return state if isinstance(state, str) else None
    return None


def _denied_command(row: dict[str, Any]) -> str | None:
    arguments = row.get("arguments")
    if isinstance(arguments, dict):
        command = arguments.get("command")
        if isinstance(command, str):
            return command
    return None


def _pins_json(pins: ComparisonPins) -> dict[str, Any]:
    return {
        "model": pins.model,
        "dataset": pins.dataset,
        "permission_mode": pins.permission_mode,
        "max_turns": pins.max_turns,
        "eval_state": pins.eval_state,
    }


def _opt_str(value: Any) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _opt_int(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    return value
