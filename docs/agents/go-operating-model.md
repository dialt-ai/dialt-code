# Go operating model

This is the default change workflow for Converse Code. Its purpose is confidence per line of code, not maximum test count. Read this together with the [domain-first operating model](domain-first-operating-model.md).

## Start from behavior

State the user, protocol, security, or operational behavior being protected. Trace its real boundary-to-outcome path before choosing a test seam. A test must have concise answers to all of these questions:

- What observable behavior does it protect?
- What distinct failure would make it fail?
- Why would a cheaper existing test not catch that failure?
- Is this the strongest practical layer at which to observe the behavior?

If those answers are unclear, delete or rewrite the test. Organize the inventory by behavior and failure mode, not by function, class, or source module.

## Tests must justify their maintenance cost

Delete or rewrite tests that:

- read source, HTML, documentation, or project metadata and assert their literals;
- restate constants, generated manifests, private dictionaries, or exact helper call sequences;
- require edits whenever a harmless implementation detail changes;
- duplicate a stronger integration or boundary test without adding a distinct failure signal;
- manufacture impossible collaborators or mutate private state;
- merely call a function without asserting an observable result;
- assert the absence of fields or features production no longer writes;
- depend on runtime scheduling internals, such as a fixed number of event-loop ticks before an outcome appears.

Delete absence assertions together with the feature they once guarded. Replace tick counting by awaiting the observable frame or result within a bounded timeout, so the test passes on every supported runtime; the wait must name the missing condition on expiry rather than raise an anonymous timeout. Rejection cases for one boundary parser belong together: drive one fake through each invalid shape, named per case, rather than duplicating a bespoke server per shape.

A check that cannot run at all in an environment (a runtime too old for the file format, a missing browser) must skip with the requirement named, not fail as though the contract broke — a red that means "wrong machine" trains readers to ignore red. But a skip is only acceptable while at least one mandated verification path still runs the check red-on-failure; a check that skips everywhere has been deleted in disguise.

A periodic sweep that finds nothing to delete is a result, not a failure — record it and stop. Do not manufacture deletions to make a sweep look productive; the durable inventory below is the standard, and matching it is the goal. When a sweep does find something, prefer the smallest honest change: consolidate scaffolding, fix determinism, and only then delete.

Exact values remain appropriate when they are the external contract itself, such as a tool manifest, wire encoding, security permission, or documented protocol limit. Assert them where the consumer observes them. Keep one canonical package version and derive runtime metadata from it instead of testing duplicated declarations for equality.

Prefer the strongest test that is still deterministic and affordable. A lower-level test earns a place beside a broader one only when it protects a separate boundary invariant, identifies a materially different failure, or makes an otherwise impractical case deterministic. Do not keep every layer merely because each can assert the same happy path.

## Exercise reachable states

Drive stateful behavior through the events and commands available in production. Do not assign phases, active identifiers, pending decisions, or other private fields to arrange a scenario. Such tests admit states the application may never produce and force internal representations to remain stable.

Test doubles should simulate an external boundary, not mirror the production implementation. Assert semantic ordering only where ordering is part of the protocol; avoid snapshots of complete callback sequences when a public outcome proves the behavior. Diagnostic traces are observed at the trace file: assert redaction and the specific fact a record must carry, never a component's internal emit sequence.

Regression tests should reproduce the failure mechanism through inputs and event order, then assert the public outcome. When a stronger boundary test later subsumes that regression, remove the narrower duplicate.

## Simplify after deleting tests

Every test removal triggers a production search for the seam it kept alive. Remove test-only flags, constructor parameters, accessors, callbacks, branches, helpers, and data fields. A default argument only tests exercise is such a seam: when production always supplies the collaborator, require it. Do not parameterize production timeouts, credentials, or modes solely to make tests faster or easier to arrange. Test at the appropriate boundary instead.

Follow removals through every caller, serializer, trace, and UI consumer. Git history preserves deleted abstractions; production does not need compatibility with tests that no longer exist.

## Parse, then operate

Follow the domain-first operating model. Boundary code parses; domain code operates on valid values. Prefer immutable values and explicit state alternatives. If a bug arises from two fields disagreeing, replace the pair with one representation instead of adding another validator.

## Verification ladder

Run the narrowest behavioral tests while developing, then the complete deterministic suite and browser suite. Review the final diff for unnecessary seams, state contradictions, security regressions, and accidentally deleted behavior. A green suite is necessary but not sufficient: inspect what the remaining tests actually prove.

For this repository, the durable behavioral inventory is:

- HTTP, WebSocket, credential, origin, and token security boundaries;
- Pi command acknowledgement, ownership attribution, fail-closed disconnects, cancellation, and approval decisions;
- the public Dialt background-tool manifest and lifecycle outcomes;
- browser transcript provenance, interruption ordering, queued approval interactions, durable control replay, microphone mute/end lifecycle, autoscroll, and user-visible activity state;
- session trace structure and redaction.

Wholesale instruction-copy checks, CLI help snapshots, package-version self-comparisons, private-state router setup, exact internal callback lists, trace-emission sequence snapshots, page identity literals such as the title and heading, and tests already subsumed by the Chromium lifecycle do not earn permanent maintenance cost. A small prompt contract can still be justified when it protects a critical routing constraint that cannot be exercised deterministically at a stronger boundary.

## Lessons from test audits

- Do not retain response data merely because a test can inspect it. Pi command acknowledgements
  carry extensible fields, but Converse Code only needs the correlated command ID. Snapshotting the
  unused fields forced an otherwise meaningless `CommandReceipt` representation into production.
- Fold protocol detail into the test that owns the behavior. Structured approval interactions now
  ride the durable-control replay test instead of a second test that asserted the bridge's exact
  trace callback sequence.
- Give one layer ownership of each browser behavior. Microphone muting belongs to the microphone
  lifecycle scenario; approval interaction options belong to the busy-floor interaction scenario.
  Broad page and deferred-status tests should not repeat those assertions.
