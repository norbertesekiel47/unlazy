# Orchestrated mode: leaves as fresh agents

For tree depth 4+ or any build clearly beyond one sitting. The core insight:
the stall-at-80-percent failure is an end-of-long-context disease. Attention,
not time, is the scarce resource, and a fresh subagent per leaf resets it.

## The driver loop

You (the main session) are the driver. You do not implement leaves; you
plan, dispatch, verify, and integrate.

1. **Plan.** Write PLAN.md (contract, tree, `Owns`/`Needs`/`Tier` per leaf,
   dispatch schedule, gates file per leaf and branch) from templates/PLAN.md.
   This is the only step where the whole task must fit in one head. `Owns` is
   the leaf's file lease, `Needs` names the leaves it waits on, and a leaf with
   an empty `Needs` is ready immediately.
2. **Dispatch every ready leaf at once.** Not one at a time. The contract
   already guarantees disjoint file ownership, so ready leaves cannot collide;
   holding them back buys nothing and costs wall-clock. Each brief is:
   - the contract section of PLAN.md (not the whole file, not your history)
   - its own gates file, verbatim
   - the instruction: work the four passes until every gate is met with
     evidence, then stop; if a gate is impossible, ABANDON it with a reason.
3. **Verify on return, one leaf at a time, never trust.** As each leaf comes
   back, re-run **its** checks and nothing else:
   `node <skill-dir>/scripts/gate-check.mjs --jobs 8 gates/leaf-x.md`
   Name the file. A bare `gate-check` globs `GATES.md` plus every `gates/*.md`,
   so a twelve-leaf tree re-runs all twelve checks on every single verify. A
   leaf that checked its own boxes without evidence gets sent back with the
   specific unmet gates named. This is the layer that makes self-certification
   worthless.
4. **Advance immediately.** Append one line to PLAN.md's status log, then
   dispatch whatever that leaf just unblocked. Do not wait for its siblings.
   Rolling dispatch keeps every worker busy; wave-by-wave dispatch idles the
   whole fleet behind the slowest leaf in the wave.
5. **Close the branch.** When all children of a branch are verified, work its
   integration gates yourself (or dispatch an integration leaf). Branch gates
   are where the whole-project checks live: the full build, the full suite,
   the cross-child smoke test. They run once, here, not once per leaf.
6. **Report.** Only when the root's gates are met. Paste the ledger, N of N,
   with every ABANDON line surfaced, and re-measure every number you state.

## Keeping verification cheap

Verification is the last thing to cut, so make it fast instead:

- **Name the files.** `gate-check.mjs gates/leaf-x.md` verifies one leaf.
  Passing the file you care about is the difference between re-running two
  checks and re-running the tree.
- **Use `--jobs`.** Independent CHECK commands run concurrently:
  `--jobs 8` turns eight one-second checks into one second. The default is 1,
  which is sequential and unchanged from before.
- **Share checks deliberately.** Identical CHECK command strings run once per
  invocation and every gate naming them reads the same output, with its own
  EXPECT applied. A branch gate that re-runs its children's exact commands
  therefore pays for each distinct command once, not once per child.
- **Blocking edges, not polling.** A leaf whose `Needs` are unmet is not
  dispatched at all. Do not dispatch it and let it discover the dependency.

## Verification hierarchy

Three layers, weakest to strongest, each catching what the layer below
misses:

1. **Leaf self-check**: gate-check run by the leaf itself, on its own gates
   file. Catches honest incompleteness, misses self-deception.
2. **Parent re-run**: the driver re-executes the checks. Catches
   self-deception and environment differences.
3. **Stop-hook** (Claude Code, optional): structurally blocks a session from
   ending while gates are unmet. Catches the driver itself drifting into
   report mode.

Prose discipline is layer zero and it is the weakest; that is the lesson v2
is built on. Prefer moving any repeated judgment call up this hierarchy:
if you find yourself re-checking the same thing twice by reading, write a
CHECK command for it.

## Model and effort tiering

Every leaf carries a `Tier` in PLAN.md. Where the harness allows choosing a
model or reasoning effort per subagent, honor it:

- `cheap`: mechanical leaves. Rename sweeps, fixture generation, applying a
  pattern already decided elsewhere. Low effort, cheaper model.
- `strong`: design leaves, integration branches, and every verification pass.

The driver stays on the strong model always; a weak driver invalidates every
verification above layer one. When a harness exposes a router or model-choice
skill, delegate the tier decision to it and record what it returned in
PLAN.md; otherwise assign the tier yourself at plan time, when the leaf's
character is clearest, and do not revisit it per dispatch.

## When NOT to orchestrate

Below roughly half an hour of real work, subagent overhead (context
re-establishment per leaf) costs more than it buys. Stay solo: one GATES.md,
one session, same discipline. The gates still do their job; you just skip
the dispatch machinery.
