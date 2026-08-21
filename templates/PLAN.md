# Plan: <task>

Depth: tree <N>   Mode: orchestrated
Budget note: <what a competent single pass would take; context, not arithmetic>

## Contract

Decided BEFORE fan-out. Everything a leaf could get wrong about its neighbors:

- Interfaces: <function signatures, file formats, API shapes>
- Data ownership: <which leaf owns which files; no two leaves share a file>
- Naming and conventions: <casing, folder layout, error handling style>

## Tree

- 1 <task>
  - 1.1 <branch> .......... gates/node-1.1.md
    - 1.1.1 <leaf> ........ gates/leaf-1.1.1.md
    - 1.1.2 <leaf> ........ gates/leaf-1.1.2.md
  - 1.2 <branch> .......... gates/node-1.2.md
    - 1.2.1 <leaf> ........ gates/leaf-1.2.1.md
    - 1.2.2 <leaf> ........ gates/leaf-1.2.2.md

## Leaves

`Owns` is the file lease; no two leaves may share one. `Needs` lists the leaves
that must be verified first, and an empty `Needs` means ready at fan-out.
`Tier` is `cheap` for mechanical work and `strong` for design, integration and
every verification pass.

| Leaf | Gates file | Owns | Needs | Tier |
|---|---|---|---|---|
| 1.1.1 | gates/leaf-1.1.1.md | <paths> | none | cheap |
| 1.1.2 | gates/leaf-1.1.2.md | <paths> | 1.1.1 | strong |
| 1.2.1 | gates/leaf-1.2.1.md | <paths> | none | strong |
| 1.2.2 | gates/leaf-1.2.2.md | <paths> | none | cheap |

## Dispatch schedule

Rolling, not wave by wave. Dispatch every leaf whose `Needs` are satisfied,
verify each one as it returns (`gate-check.mjs --jobs 8 gates/leaf-x.md`), then
immediately dispatch whatever it unblocked. Never idle the fleet waiting for
the slowest leaf of a wave.

- Ready at fan-out: <1.1.1, 1.2.1, 1.2.2>
- Unblocked by 1.1.1: <1.1.2>
- Branch gates: <node-1.1 after 1.1.1 + 1.1.2; node-1.2 after 1.2.1 + 1.2.2>
- Root gates: <after every branch is green>

## Status log

Append-only. One line per event: leaf started, leaf verified, gate abandoned.
Never rewrite lines above; appending keeps the file cheap to re-read and diff.

- <timestamp or step> plan written, contract fixed
