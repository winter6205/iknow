"""T9 / SC13: benchmark failure attribution that never rewrites the raw score.

Stdlib `unittest` on purpose: the environment has no pytest, and the existing
`test_iknow_adapter.py` / `test_parse_iknow_ask_output.py` are pytest suites
that must not be modified. Run with:

    python3 -m unittest discover -s scripts/harbor/tests -p 'test_benchmark_*.py' -t scripts/harbor/tests

Every fixture is the *real* artifact format — Harbor's `result.json`, a bare
`verifier/reward.txt`, a `verifier/ctrf.json` summary, a `verifier/test-stdout.txt`
pytest log, and the JSONL trace the ask route really writes — laid out in a
fresh `mkdtemp` tree. Nothing here reaches the repository's `data/` or a user
session directory.

The load-bearing negative cases are the ones the spec calls out by name: a deny
alone, a timeout alone and a turn cap alone must each land on
`unknown_or_mixed`, and must not even be *acceptable* as causal evidence.
"""

import json
import os
import sys
import tempfile
import unittest
from dataclasses import replace

sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "iknow_harbor"),
)

import attribution  # noqa: E402
from attribution import (  # noqa: E402
    HARNESS_BLOCK,
    MODEL_OR_POLICY,
    UNKNOWN_OR_MIXED,
    AttributedTrial,
    AttributionRequest,
    CausalEvidence,
    ComparisonPins,
    ConflictingPinError,
    InsufficientRepetitionError,
    NonCausalEvidenceError,
    TrialPins,
    attribute_trials,
    build_report,
    compare_runs,
    read_trial,
    verify_pins,
)

# --------------------------------------------------------------------------
# Real-format artifact builders
# --------------------------------------------------------------------------

CONV_A = "3f6c9d1e-8a2b-4c5d-9e7f-0a1b2c3d4e5f"
CONV_B = "7b1e2d3c-4a5b-6c7d-8e9f-0a1b2c3d4e60"


def tool_call_row(
    conversation_id,
    tool_call_id,
    command,
    *,
    tool_kind="execution_failed",
    status="error",
    message="[permission_denied] [hard_wall] dangerous command",
    cause=None,
    cleanup=None,
):
    """A `tool_call` row exactly as src/harness/trace/jsonl.ts writes it."""
    row = {
        "conversation_id": conversation_id,
        "record_type": "tool_call",
        "tool_call_id": tool_call_id,
        "parent_llm_call_id": "11111111-2222-3333-4444-555555555555",
        "tool_name": "bash",
        "tool_kind": tool_kind,
        "started_at": "2026-09-30T10:00:00.000Z",
        "ended_at": "2026-09-30T10:00:00.120Z",
        "duration_ms": 120,
        "arguments_captured": True,
        "arguments": {"command": command},
        "result_captured": False,
        "status": status,
        "error": {"type": tool_kind, "message": message},
    }
    if cause is not None:
        row["cause"] = cause
    if cleanup is not None:
        row["cleanup"] = cleanup
    return row


def violation_row(
    conversation_id,
    violation_id,
    *,
    tier="mid",
    tool="bash",
    message="[permission_denied] [hard_wall] dangerous command",
    turn_id="aaaa-bbbb-cccc",
    confirmed_violations=None,
    cleanup=None,
):
    """A `violation` row as src/harness/trace/violation-record.ts writes it."""
    row = {
        "conversation_id": conversation_id,
        "record_type": "violation",
        "violation_id": violation_id,
        "ts": "2026-09-30T10:00:01.000Z",
        "tier": tier,
        "tool": tool,
        "message": message,
        "turn_id": turn_id,
        "detail": {"tier": tier, "tool": tool, "message": message},
    }
    if confirmed_violations is not None:
        row["confirmed_violations"] = confirmed_violations
    if cleanup is not None:
        row["cleanup"] = cleanup
    return row


def turn_row(conversation_id, turn_id, tool_call_ids, decision="completed"):
    return {
        "conversation_id": conversation_id,
        "record_type": "turn",
        "turn_id": turn_id,
        "turn_index": 1,
        "started_at": "2026-09-30T10:00:00.000Z",
        "ended_at": "2026-09-30T10:00:02.000Z",
        "duration_ms": 2000,
        "llm_call_ids": ["11111111-2222-3333-4444-555555555555"],
        "tool_call_ids": list(tool_call_ids),
        "decision": decision,
        "status": "error" if decision != "completed" else "ok",
    }


CTRF_PASSING = {
    "results": {
        "tests": [
            {"name": "test_input_file_matches", "status": "passed"},
            {"name": "test_compilation_successful", "status": "passed"},
        ],
        "summary": {"tests": 2, "passed": 2, "failed": 0},
    }
}

CTRF_FAILING = {
    "results": {
        "tests": [
            {"name": "test_ars_function_exists", "status": "passed"},
            {"name": "test_sample_generation", "status": "failed"},
        ],
        "summary": {"tests": 2, "passed": 1, "failed": 1},
    }
}

TEST_STDOUT_PYTEST = "============================= test session starts ==============================\ncollected 2 items\n\n======================== 1 failed, 1 passed in 0.10s =========================\n"
TEST_STDOUT_BROKEN = "curl: (28) Connection timed out after 130000 milliseconds\nuvx: command not found\n"


class TrialBuilder:
    """Lay out one Harbor trial directory in the real on-disk shape."""

    def __init__(self, root, name, *, reward="0", ctrf=CTRF_FAILING,
                 stdout=TEST_STDOUT_PYTEST, trace_rows=None, trace_name=CONV_A,
                 trace_written=True, metadata=None, exception_type=None):
        self.dir = os.path.join(root, name)
        self.trace_name = trace_name
        verifier = os.path.join(self.dir, "verifier")
        trace_dir = os.path.join(
            self.dir, "artifacts", "logs", "agent", "trace"
        )
        os.makedirs(verifier)
        os.makedirs(trace_dir)

        meta = {
            "permission_mode": "full_auto",
            "eval_state": True,
            "turn_count": 18,
        }
        meta.update(metadata or {})

        result = {
            "task_name": name.split("__", 1)[0],
            "trial_name": name,
            "verifier_environment_mode": "shared",
            "agent_result": {"metadata": meta},
        }
        if exception_type is not None:
            result["exception_info"] = {
                "exception_type": exception_type,
                "exception_message": "boom",
            }
        self._write_json(os.path.join(self.dir, "result.json"), result)

        if reward is not None:
            self._write_text(
                os.path.join(verifier, "reward.txt"), reward.strip() + "\n"
            )
        if ctrf is not None:
            self._write_json(os.path.join(verifier, "ctrf.json"), ctrf)
        if stdout is not None:
            self._write_text(
                os.path.join(verifier, "test-stdout.txt"), stdout
            )

        if trace_written:
            self._write_trace(
                os.path.join(trace_dir, trace_name + ".jsonl"), trace_rows or []
            )
            meta["trace_out"] = "/logs/agent/trace"
            meta["trace_file"] = "/logs/agent/trace/%s.jsonl" % trace_name
            meta["trace_conversation_id"] = trace_name
            meta["trace_state"] = "present"
            self._write_json(os.path.join(self.dir, "result.json"), result)
        else:
            meta["trace_out"] = "/logs/agent/trace"
            meta["trace_state"] = "absent"
            meta["trace_write_failed"] = True
            self._write_json(os.path.join(self.dir, "result.json"), result)

    @staticmethod
    def _write_json(path, payload):
        with open(path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)

    @staticmethod
    def _write_text(path, text):
        with open(path, "w", encoding="utf-8") as handle:
            handle.write(text)

    @staticmethod
    def _write_trace(path, rows):
        with open(path, "w", encoding="utf-8") as handle:
            for row in rows:
                handle.write(json.dumps(row) + "\n")


def deny_only_trace(conv=CONV_A):
    """A run whose trace holds one hard-wall deny and nothing else causal."""
    deny_id = "aaaaaaaa-1111-2222-3333-444444444444"
    return [
        tool_call_row(conv, deny_id, "cat /etc/shadow"),
        turn_row(conv, "aaaa-bbbb-cccc", [deny_id], decision="cancelled"),
    ]


def timeout_only_trace(conv=CONV_A):
    call_id = "bbbbbbbb-1111-2222-3333-444444444444"
    return [
        tool_call_row(
            conv,
            call_id,
            "npm install",
            tool_kind="execution_failed",
            message="timeout",
            cause="timeout",
            cleanup={"state": "unconfirmed", "reason": "observation_expired",
                     "pgid": 4242, "detail": "group still present"},
        ),
        turn_row(conv, "aaaa-bbbb-cccc", [call_id], decision="completed"),
    ]


def interrupted_trace(conv=CONV_A):
    call_id = "cccccccc-1111-2222-3333-444444444444"
    return [
        tool_call_row(conv, call_id, "cat /etc/shadow"),
        violation_row(
            conv,
            "dddddddd-1111-2222-3333-444444444444",
            confirmed_violations=3,
            cleanup=[
                {
                    "kind": "background_task",
                    "id": "bg-1",
                    "state": "confirmed_stopped",
                    "cleanup": {"state": "confirmed_stopped", "pgid": 777,
                                "task_id": "bg-1"},
                }
            ],
        ),
        turn_row(conv, "aaaa-bbbb-cccc", [call_id], decision="cancelled"),
    ]


def reviewer_evidence():
    return CausalEvidence(
        kind="alice",
        reference="review-2026-09-30.md#adaptive-rejection-sampler",
    )


def human_causal(kind, reference, reviewer="alice"):
    return CausalEvidence(kind=kind, detail="reviewed by hand",
                          reference=reference, reviewed_by=reviewer)


# --------------------------------------------------------------------------


class AttributionTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        self.addCleanup(self._tmp.cleanup)

    def trial(self, name, **kwargs):
        return TrialBuilder(self.root, name, **kwargs)

    def attribute(self, path, request=None):
        request = request or AttributionRequest(reviewer="alice")
        return attribution.attribute_trial(read_trial(path), request)


class NegativeAttributionTests(AttributionTestCase):
    """A deny, a timeout and a turn cap are facts, never causal evidence."""

    def test_deny_only_trial_is_unknown_not_harness_induced(self):
        self.trial("overfull-hbox__a1", reward="0", trace_rows=deny_only_trace())
        attributed = self.attribute(
            os.path.join(self.root, "overfull-hbox__a1")
        )

        # The fact is recorded...
        self.assertEqual(attributed.facts.denied_tool_calls, 1)
        self.assertEqual(attributed.facts.denied_commands, ("cat /etc/shadow",))
        # ...and it decides nothing.
        self.assertEqual(attributed.label, UNKNOWN_OR_MIXED)
        self.assertNotEqual(attributed.label, HARNESS_BLOCK)
        self.assertIn("no causal evidence", attributed.rationale)

    def test_timeout_only_trial_is_not_a_model_failure(self):
        self.trial("overfull-hbox__a2", reward="0", trace_rows=timeout_only_trace())
        attributed = self.attribute(
            os.path.join(self.root, "overfull-hbox__a2")
        )
        self.assertEqual(attributed.facts.timed_out_tool_calls, 1)
        self.assertEqual(attributed.facts.unconfirmed_cleanup_tool_calls, 1)
        self.assertEqual(attributed.label, UNKNOWN_OR_MIXED)
        self.assertNotEqual(attributed.label, MODEL_OR_POLICY)

    def test_turn_cap_only_trial_is_not_a_model_failure(self):
        self.trial(
            "overfull-hbox__a3",
            reward="0",
            trace_rows=deny_only_trace(),
            metadata={"turn_count": 40, "iknow_error": "max_turns_exceeded",
                      "stop_reason": "max_turns_exceeded"},
        )
        attributed = self.attribute(
            os.path.join(self.root, "overfull-hbox__a3")
        )
        self.assertTrue(attributed.raw.turn_cap_reached)
        self.assertEqual(attributed.label, UNKNOWN_OR_MIXED)
        self.assertNotEqual(attributed.label, MODEL_OR_POLICY)

    def test_trace_facts_cannot_be_submitted_as_causal_evidence(self):
        for kind in attribution.NON_CAUSAL_EVIDENCE_KINDS:
            with self.subTest(kind=kind):
                with self.assertRaises(NonCausalEvidenceError):
                    CausalEvidence(
                        kind=kind,
                        detail="it happened",
                        reference="trace.jsonl",
                        reviewed_by="alice",
                    )

    def test_evidence_without_a_named_reviewer_cannot_be_constructed(self):
        with self.assertRaises(TypeError):
            # `reviewed_by` has no default: a causal finding cannot be
            # constructed without a name attached to it.
            CausalEvidence(
                kind="false_denial_prevented_completion",
                detail="claimed but nobody signed it",
                reference="trace.jsonl#tool_call_id=aaaaaaaa",
            )
        with self.assertRaises(ValueError):
            CausalEvidence(
                kind="false_denial_prevented_completion",
                detail="signed by nobody",
                reference="trace.jsonl",
                reviewed_by="   ",
            )

    def test_evidence_without_a_reference_cannot_be_constructed(self):
        with self.assertRaises(ValueError):
            human_causal("false_denial_prevented_completion", "  ")

    def test_request_without_a_reviewer_is_refused(self):
        self.trial("overfull-hbox__a5", reward="0", trace_rows=deny_only_trace())
        with self.assertRaises(ValueError):
            AttributionRequest(reviewer="  ")


class PositiveAttributionTests(AttributionTestCase):
    def test_confirmed_causal_evidence_yields_a_harness_label(self):
        self.trial("overfull-hbox__b1", reward="0", trace_rows=deny_only_trace())
        request = AttributionRequest(
            reviewer="alice",
            evidence=[
                human_causal(
                    "false_denial_prevented_completion",
                    "trace.jsonl#tool_call_id=aaaaaaaa-1111-2222-3333-444444444444",
                )
            ],
            note="cat /etc/shadow is not needed to rebuild the tex file",
        )
        attributed = self.attribute(
            os.path.join(self.root, "overfull-hbox__b1"), request
        )
        self.assertEqual(attributed.label, HARNESS_BLOCK)
        self.assertEqual(
            attributed.evidence_references,
            ("trace.jsonl#tool_call_id=aaaaaaaa-1111-2222-3333-444444444444",),
        )

    def test_cleanup_fault_evidence_yields_a_harness_label(self):
        self.trial("overfull-hbox__b2", reward="0", trace_rows=timeout_only_trace())
        request = AttributionRequest(
            reviewer="bob",
            evidence=[
                human_causal(
                    "cleanup_fault_prevented_completion",
                    "trace.jsonl#tool_call_id=bbbbbbbb-1111-2222-3333-444444444444",
                )
            ],
        )
        attributed = self.attribute(
            os.path.join(self.root, "overfull-hbox__b2"), request
        )
        self.assertEqual(attributed.label, HARNESS_BLOCK)

    def test_confirmed_violation_evidence_yields_a_model_label(self):
        self.trial(
            "password-recovery__b3",
            reward="0",
            trace_rows=interrupted_trace(),
            metadata={"iknow_error": None, "stop_reason": "cancelled"},
        )
        request = AttributionRequest(
            reviewer="carol",
            evidence=[
                human_causal(
                    "confirmed_security_violation",
                    "trace.jsonl#violation_id=dddddddd-1111-2222-3333-444444444444",
                )
            ],
        )
        attributed = self.attribute(
            os.path.join(self.root, "password-recovery__b3"), request
        )
        self.assertEqual(attributed.label, MODEL_OR_POLICY)
        self.assertEqual(attributed.facts.security_interruptions, 1)
        self.assertEqual(attributed.facts.confirmed_violations, 3)
        self.assertEqual(attributed.facts.unconfirmed_cleanup_items, 0)

    def test_violation_facts_alone_do_not_label_a_trial(self):
        self.trial("password-recovery__b4", reward="0",
                   trace_rows=interrupted_trace())
        attributed = self.attribute(
            os.path.join(self.root, "password-recovery__b4")
        )
        self.assertEqual(attributed.label, UNKNOWN_OR_MIXED)
        self.assertEqual(attributed.facts.confirmed_violations, 3)

    def test_conflicting_evidence_stays_unknown(self):
        self.trial("overfull-hbox__b5", reward="0", trace_rows=deny_only_trace())
        request = AttributionRequest(
            reviewer="alice",
            evidence=[
                human_causal("false_denial_prevented_completion", "a"),
                human_causal("wrong_answer", "b", reviewer="bob"),
            ],
        )
        attributed = self.attribute(
            os.path.join(self.root, "overfull-hbox__b5"), request
        )
        self.assertEqual(attributed.label, UNKNOWN_OR_MIXED)
        self.assertIn("conflict", attributed.rationale)

    def test_an_evaluator_fault_alone_stays_unknown(self):
        # The pilot's torch case: reward 0.0, the tests never ran, the runner
        # could not be installed. Real, and still not the harness or the model.
        self.trial("torch-tensor-parallelism__b7", reward="0.0", ctrf=None,
                   stdout=TEST_STDOUT_BROKEN, trace_written=False)
        request = AttributionRequest(
            reviewer="alice",
            evidence=[
                CausalEvidence(
                    kind="verifier_never_ran",
                    detail="uvx could not be installed in the verifier phase",
                    reference="verifier/test-stdout.txt",
                    reviewed_by="alice",
                )
            ],
        )
        attributed = self.attribute(
            os.path.join(self.root, "torch-tensor-parallelism__b7"), request
        )
        self.assertEqual(attributed.label, UNKNOWN_OR_MIXED)
        self.assertNotEqual(attributed.label, HARNESS_BLOCK)
        self.assertNotEqual(attributed.label, MODEL_OR_POLICY)

    def test_an_evaluator_fault_beside_a_harness_finding_stays_unknown(self):
        # The two cannot be separated, so neither is applied.
        self.trial("overfull-hbox__b8", reward="0", trace_rows=deny_only_trace())
        request = AttributionRequest(
            reviewer="alice",
            evidence=[
                human_causal("environment_fault", "install.txt"),
                human_causal("false_denial_prevented_completion", "a"),
            ],
        )
        attributed = self.attribute(
            os.path.join(self.root, "overfull-hbox__b8"), request
        )
        self.assertEqual(attributed.label, UNKNOWN_OR_MIXED)

    def test_a_model_finding_on_a_passing_trial_stays_unknown(self):
        self.trial("overfull-hbox__b9", reward="1", ctrf=CTRF_PASSING,
                   trace_rows=deny_only_trace())
        request = AttributionRequest(
            reviewer="alice",
            evidence=[human_causal("wrong_answer", "a")],
        )
        attributed = self.attribute(
            os.path.join(self.root, "overfull-hbox__b9"), request
        )
        self.assertEqual(attributed.label, UNKNOWN_OR_MIXED)
        self.assertTrue(attributed.raw.passed)

    def test_block_evidence_on_a_passing_trial_stays_unknown(self):
        self.trial("overfull-hbox__b6", reward="1", ctrf=CTRF_PASSING,
                   trace_rows=deny_only_trace())
        request = AttributionRequest(
            reviewer="alice",
            evidence=[
                human_causal("false_denial_prevented_completion", "trace.jsonl")
            ],
        )
        attributed = self.attribute(
            os.path.join(self.root, "overfull-hbox__b6"), request
        )
        self.assertEqual(attributed.label, UNKNOWN_OR_MIXED)
        self.assertIn("passing", attributed.rationale)

    def test_unknown_evidence_kind_is_refused_outright(self):
        with self.assertRaises(ValueError):
            CausalEvidence(kind="felt_wrong", detail="x", reference="y",
                           reviewed_by="alice")


class RawOutcomeImmutabilityTests(AttributionTestCase):
    def test_attribution_does_not_touch_any_artifact_byte(self):
        path = os.path.join(self.root, "overfull-hbox__c1")
        self.trial("overfull-hbox__c1", reward="0", trace_rows=deny_only_trace())
        before = _snapshot(path)

        request = AttributionRequest(
            reviewer="alice",
            evidence=[
                human_causal("runtime_fault_prevented_completion", "trace.jsonl")
            ],
        )
        attributed = self.attribute(path, request)
        self.assertEqual(attributed.label, HARNESS_BLOCK)

        self.assertEqual(_snapshot(path), before)

    def test_raw_pass_fail_set_and_score_are_unchanged_by_attribution(self):
        self.trial("prove-plus-comm__c2", reward="1", ctrf=CTRF_PASSING,
                   trace_rows=deny_only_trace())
        self.trial("adaptive-rejection-sampler__c3", reward="0",
                   trace_rows=deny_only_trace())
        self.trial("crack-7z-hash__c4", reward="0", trace_rows=timeout_only_trace())

        raw_before = [
            (read_trial(os.path.join(self.root, n)).raw.task_name,
             read_trial(os.path.join(self.root, n)).raw.reward,
             read_trial(os.path.join(self.root, n)).raw.passed)
            for n in ("prove-plus-comm__c2",
                      "adaptive-rejection-sampler__c3",
                      "crack-7z-hash__c4")
        ]

        report = build_report(
            attribute_trials(
                [
                    os.path.join(self.root, n)
                    for n in ("prove-plus-comm__c2",
                              "adaptive-rejection-sampler__c3",
                              "crack-7z-hash__c4")
                ],
                AttributionRequest(
                    reviewer="alice",
                    evidence=[
                        human_causal(
                            "false_denial_prevented_completion",
                            "trace.jsonl",
                        )
                    ],
                ),
            )
        )

        raw_after = [
            (read_trial(os.path.join(self.root, n)).raw.task_name,
             read_trial(os.path.join(self.root, n)).raw.reward,
             read_trial(os.path.join(self.root, n)).raw.passed)
            for n in ("prove-plus-comm__c2",
                      "adaptive-rejection-sampler__c3",
                      "crack-7z-hash__c4")
        ]
        self.assertEqual(raw_after, raw_before)
        # And the report's own raw tally is the whole set, not a subset.
        self.assertEqual(report.raw.total_trials, 3)
        self.assertEqual(report.raw.passes, 1)
        self.assertEqual(report.raw.failures, 2)
        self.assertEqual(report.raw.passes + report.raw.failures, 3)

    def test_attributed_harness_block_stays_in_the_raw_failure_total(self):
        self.trial("prove-plus-comm__c5", reward="1", ctrf=CTRF_PASSING)
        self.trial("overfull-hbox__c6", reward="0", trace_rows=deny_only_trace())
        report = build_report(
            attribute_trials(
                [os.path.join(self.root, n)
                 for n in ("prove-plus-comm__c5", "overfull-hbox__c6")],
                AttributionRequest(
                    reviewer="alice",
                    evidence=[
                        human_causal(
                            "false_denial_prevented_completion", "trace.jsonl"
                        )
                    ],
                ),
            )
        )
        self.assertEqual(report.label_counts[HARNESS_BLOCK], 1)
        self.assertEqual(report.raw.failures, 1)
        self.assertEqual(report.raw.total_trials, 2)
        # The attributed subset is named as a subset, never as the score.
        self.assertLessEqual(
            report.raw.failures - report.label_counts[HARNESS_BLOCK],
            report.raw.failures,
        )
        self.assertFalse(report.is_attributed_subset_the_score)

    def test_trials_with_no_reward_are_counted_separately_not_as_failures(self):
        self.trial("dna-assembly__c7", reward=None, ctrf=None, stdout=None,
                   trace_written=False,
                   metadata={"turn_count": None},
                   exception_type="NonZeroAgentExitCodeError")
        report = build_report(
            attribute_trials(
                [os.path.join(self.root, "dna-assembly__c7")],
                AttributionRequest(reviewer="alice"),
            )
        )
        self.assertIsNone(report.trials[0].raw.reward)
        self.assertIsNone(report.trials[0].raw.passed)
        self.assertEqual(report.raw.failures, 0)
        self.assertEqual(report.raw.no_outcome, 1)
        self.assertEqual(report.raw.total_trials, 1)

    def test_missing_ctrf_does_not_rewrite_the_raw_reward(self):
        # The pilot's torch case: harbor wrote reward 0.0 and the tests never
        # ran. The raw outcome stays a failure; the fact is reported beside it.
        self.trial("torch-tensor-parallelism__c8", reward="0.0", ctrf=None,
                   stdout="Connection timed out", trace_written=False)
        report = build_report(
            attribute_trials(
                [os.path.join(self.root, "torch-tensor-parallelism__c8")],
                AttributionRequest(reviewer="alice"),
            )
        )
        trial = report.trials[0]
        self.assertEqual(trial.raw.reward, 0.0)
        self.assertFalse(trial.raw.passed)
        self.assertFalse(trial.raw.tests_executed)
        self.assertEqual(report.raw.failures, 1)

    def test_missing_trace_is_named_not_treated_as_success(self):
        self.trial("overfull-hbox__c9", reward="0", trace_written=False)
        attributed = self.attribute(
            os.path.join(self.root, "overfull-hbox__c9")
        )
        self.assertIsNone(attributed.facts)
        self.assertEqual(attributed.raw.trace_evidence_state, "absent")
        self.assertTrue(attributed.raw.trace_write_failed)
        self.assertEqual(attributed.label, UNKNOWN_OR_MIXED)

    def test_corrupt_result_json_is_reported_not_swallowed(self):
        path = os.path.join(self.root, "overfull-hbox__c10")
        self.trial("overfull-hbox__c10", reward="0")
        with open(os.path.join(path, "result.json"), "w", encoding="utf-8") as fh:
            fh.write("{not json")
        with self.assertRaises(attribution.TrialArtifactError):
            read_trial(path)


class ComparisonPinningTests(AttributionTestCase):
    PINS = ComparisonPins(
        model="minimax-cn/MiniMax-M3.1-Flash-Preview",
        dataset="terminal-bench/terminal-bench-2-1",
        permission_mode="full_auto",
        max_turns=40,
        eval_state=True,
    )

    def build(self, names_and_modes, rewards=None):
        for index, (name, mode) in enumerate(names_and_modes):
            reward = (rewards or ["0"] * len(names_and_modes))[index]
            self.trial(
                name,
                reward=reward,
                ctrf=CTRF_PASSING if reward.strip() == "1" else CTRF_FAILING,
                metadata={"permission_mode": mode},
            )
        return attribute_trials(
            [os.path.join(self.root, name) for name, _mode in names_and_modes],
            AttributionRequest(reviewer="alice"),
        )

    def test_matched_pins_with_repetitions_are_accepted(self):
        trials = self.build(
            [
                ("overfull-hbox__d1", "full_auto"),
                ("overfull-hbox__d2", "full_auto"),
                ("overfull-hbox__d3", "full_auto"),
                ("prove-plus-comm__d4", "full_auto"),
                ("prove-plus-comm__d5", "full_auto"),
            ]
        )
        report = verify_pins(trials, self.PINS)
        self.assertEqual(report.pins, self.PINS)
        # The trials record `permission_mode` and `eval_state`; model, dataset
        # and turn budget live in the harbor job config, not the artifacts, so
        # they are declared and reported unverified rather than claimed.
        self.assertEqual(
            report.unverified_pins, ("model", "dataset", "max_turns")
        )
        self.assertEqual(report.repetitions,
                         {"overfull-hbox": 3, "prove-plus-comm": 2})
        self.assertEqual(report.report.raw.total_trials, 5)

    def test_a_pin_the_artifacts_record_and_disagree_is_refused(self):
        # The same trial shape, but the run recorded the budget it executed
        # under, and it is not the declared one.
        for index in (0, 1):
            self.trial(
                "overfull-hbox__d0%d" % index,
                reward="0",
                metadata={"permission_mode": "full_auto", "max_turns": 20},
            )
        trials = attribute_trials(
            [
                os.path.join(self.root, "overfull-hbox__d00"),
                os.path.join(self.root, "overfull-hbox__d01"),
            ],
            AttributionRequest(reviewer="alice"),
        )
        with self.assertRaises(ConflictingPinError) as caught:
            verify_pins(trials, self.PINS)
        self.assertIn("max_turns", str(caught.exception))

    def test_a_recording_pin_the_trials_agree_on_is_corroborated(self):
        for index in (0, 1):
            self.trial(
                "overfull-hbox__d19" if index == 0 else "overfull-hbox__d20",
                reward="0",
                metadata={"permission_mode": "full_auto", "max_turns": 40},
            )
        trials = attribute_trials(
            [
                os.path.join(self.root, "overfull-hbox__d19"),
                os.path.join(self.root, "overfull-hbox__d20"),
            ],
            AttributionRequest(reviewer="alice"),
        )
        report = verify_pins(trials, self.PINS)
        # `max_turns` is corroborated by the trials; only the pins no artifact
        # records stay unverified.
        self.assertNotIn("max_turns", report.unverified_pins)
        self.assertNotIn("permission_mode", report.unverified_pins)

    def test_a_single_trial_per_task_is_refused(self):
        trials = self.build([("overfull-hbox__d6", "full_auto")])
        with self.assertRaises(InsufficientRepetitionError):
            verify_pins(trials, self.PINS)

    def test_a_mismatched_permission_mode_is_refused(self):
        trials = self.build(
            [
                ("overfull-hbox__d7", "full_auto"),
                ("overfull-hbox__d8", "plan"),
            ]
        )
        with self.assertRaises(ConflictingPinError) as caught:
            verify_pins(trials, self.PINS)
        self.assertIn("permission_mode", str(caught.exception))

    def test_a_mismatched_eval_state_is_refused(self):
        trials = self.build(
            [
                ("overfull-hbox__d15", "full_auto"),
                ("overfull-hbox__d16", "full_auto"),
            ]
        )
        swapped = [replace(t, raw=replace(t.raw, pins=replace(t.raw.pins, eval_state=False)))
                   for t in trials]
        with self.assertRaises(ConflictingPinError) as caught:
            verify_pins(swapped, self.PINS)
        self.assertIn("eval_state", str(caught.exception))

    def test_a_pin_no_trial_records_at_all_is_refused(self):
        # `permission_mode` missing from the artifacts is a hole in the
        # evidence, not a match: the declared value cannot be corroborated.
        trials = self.build(
            [
                ("overfull-hbox__d17", "full_auto"),
                ("overfull-hbox__d18", "full_auto"),
            ]
        )
        blanked = [
            replace(t, raw=replace(t.raw, pins=replace(t.raw.pins, permission_mode=None)))
            for t in trials
        ]
        with self.assertRaises(ConflictingPinError) as caught:
            verify_pins(blanked, self.PINS)
        self.assertIn("permission_mode", str(caught.exception))

    def test_an_empty_comparison_is_refused(self):
        with self.assertRaises(ConflictingPinError):
            verify_pins([], self.PINS)

    def test_a_run_with_no_trials_cannot_be_reported(self):
        report = build_report([])
        self.assertEqual(report.raw.total_trials, 0)
        self.assertEqual(report.raw.scored_trials, 0)

    def test_an_incomplete_pin_set_is_refused(self):
        trials = self.build(
            [
                ("overfull-hbox__d9", "full_auto"),
                ("overfull-hbox__d10", "full_auto"),
            ]
        )
        incomplete = ComparisonPins(
            model=self.PINS.model,
            dataset=self.PINS.dataset,
            permission_mode=self.PINS.permission_mode,
            max_turns=None,
            eval_state=True,
        )
        with self.assertRaises(ConflictingPinError):
            verify_pins(trials, incomplete)

    def test_trial_pins_are_read_from_the_artifacts_not_invented(self):
        trials = self.build(
            [
                ("overfull-hbox__d11", "full_auto"),
                ("overfull-hbox__d12", "full_auto"),
            ]
        )
        pins = trials[0].raw.pins
        self.assertIsInstance(pins, TrialPins)
        self.assertEqual(pins.task_name, "overfull-hbox")
        self.assertEqual(pins.permission_mode, "full_auto")
        self.assertTrue(pins.eval_state)
        # The artifacts do not record these, so they are not guessed.
        self.assertIsNone(pins.model)
        self.assertIsNone(pins.dataset)
        self.assertIsNone(pins.max_turns)

    def test_report_carries_the_unverified_pin_names(self):
        trials = self.build(
            [
                ("overfull-hbox__d13", "full_auto"),
                ("overfull-hbox__d14", "full_auto"),
            ]
        )
        # The declared pins are not readable from a trial, so the report says
        # so instead of implying the artifacts corroborated them.
        self.assertEqual(
            verify_pins(trials, self.PINS).unverified_pins,
            ("model", "dataset", "max_turns"),
        )


class CompareRunsTests(AttributionTestCase):
    PINS = ComparisonPins(
        model="minimax-cn/MiniMax-M3.1-Flash-Preview",
        dataset="terminal-bench/terminal-bench-2-1",
        permission_mode="full_auto",
        max_turns=40,
        eval_state=True,
    )

    def setUp(self):
        super().setUp()
        self.before = []
        self.after = []
        for index, mode in enumerate(("full_auto", "full_auto")):
            self.trial("overfull-hbox__e%d" % index, reward="0",
                       metadata={"permission_mode": mode})
            self.before.append(os.path.join(self.root,
                                            "overfull-hbox__e%d" % index))
        for index, mode in enumerate(("full_auto", "full_auto")):
            self.trial("overfull-hbox__f%d" % index, reward="1",
                       ctrf=CTRF_PASSING,
                       metadata={"permission_mode": mode})
            self.after.append(os.path.join(self.root,
                                           "overfull-hbox__f%d" % index))

    def report_for(self, paths):
        return verify_pins(
            attribute_trials(paths, AttributionRequest(reviewer="alice")),
            self.PINS,
        )

    def test_before_after_reports_both_raw_totals(self):
        comparison = compare_runs(self.report_for(self.before),
                                  self.report_for(self.after))
        self.assertEqual(comparison.before.raw.failures, 2)
        self.assertEqual(comparison.after.raw.passes, 2)
        self.assertEqual(comparison.before.raw.total_trials, 2)
        self.assertEqual(comparison.after.raw.total_trials, 2)

    def test_comparison_refuses_mismatched_pins(self):
        other = ComparisonPins(
            model=self.PINS.model,
            dataset=self.PINS.dataset,
            permission_mode="default",
            max_turns=40,
            eval_state=True,
        )
        with self.assertRaises(ConflictingPinError):
            compare_runs(self.report_for(self.before),
                         self.report_for(self.after)._replace(pins=other))


def _snapshot(root):
    """Every file under `root`, by relative path, as raw bytes."""
    out = {}
    for base, _dirs, files in os.walk(root):
        for name in files:
            full = os.path.join(base, name)
            with open(full, "rb") as handle:
                out[os.path.relpath(full, root)] = handle.read()
    return out


if __name__ == "__main__":
    unittest.main()
