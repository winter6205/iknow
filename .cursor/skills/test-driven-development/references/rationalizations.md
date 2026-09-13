# Extended Rationalization Playbook

Companion to SKILL.md "Rationalization Table". When you find yourself reaching for a rationalization, identify which pattern you're falling into and apply the counter-move.

## The "After" Pattern

**Trigger**: "I'll write tests after..." / "Tests can come later..."

**Reality**: Tests written after the code tests implementation, not behavior. The test passes because the code does what it does — not because the code does what it should. Behavior-driven tests require writing the spec before the implementation.

**Counter-move**: Block 5 minutes. Write the failing test first. If you can't write the test, you don't understand the behavior yet.

## The "Too Simple" Pattern

**Trigger**: "This is just a one-liner..." / "Too simple to test..."

**Reality**: Simple code gets complicated. Edge cases accumulate. Refactoring exposes the gaps. The test documents the expected behavior at the moment it was simple.

**Counter-move**: Write the test anyway. 30 seconds now saves 30 minutes later when the function gets a second parameter.

## The "Speed" Pattern

**Trigger**: "Tests slow me down..." / "I need to ship fast..."

**Reality**: Tests slow you down now. They speed you up every change after. The trade-off flips the moment you need to change code without breaking it.

**Counter-move**: Time-box the test (5 min max). If you can't write a test in 5 min, you're missing information, not missing time.

## The "Manual Test" Pattern

**Trigger**: "I tested it manually..." / "It works on my machine..."

**Reality**: Manual testing doesn't persist. Tomorrow's change might break with no way to know. The next developer doesn't have your manual test.

**Counter-move**: Capture the manual test as a script. If you can run it twice manually, you can run it as a test.

## The "Self-Explanatory" Pattern

**Trigger**: "The code is self-explanatory..." / "It's obvious what this does..."

**Reality**: Obvious to you now. Not obvious to future-you in 3 months. Not obvious to the new hire. Not obvious to the AI agent modifying the code next.

**Counter-move**: Tests ARE the specification. If the test reads as a spec, the code is doing what it says.

## The "Prototype" Pattern

**Trigger**: "It's just a prototype..." / "We'll write tests when it graduates..."

**Reality**: Prototypes become production code 80% of the time. Test debt compounds.

**Counter-move**: Write tests from day one. The cost is the same for prototype code as production code.

## The "Re-Run Reassurance" Pattern

**Trigger**: "Let me run the tests again just to be sure..."

**Reality**: After a clean run, repeating adds nothing unless code changed. Re-running on unchanged code is busywork that erodes trust in the test suite (when it eventually fails for an unrelated reason, you assume flake).

**Counter-move**: Run again only after a code change.
