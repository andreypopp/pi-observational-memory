# Concepts

This page defines the V3 vocabulary used by `pi-observational-memory`.

## The big picture

Long Pi sessions eventually outgrow the model context window. Pi solves that by compacting older messages into a summary while keeping recent messages verbatim. This extension makes that summary more durable by maintaining a branch-local memory ledger while the session happens.

In V3, the ledger is the source of truth. Compaction entries contain what the agent sees, but memory state is reconstructed by folding V3 ledger entries on the current branch.

## Memory layers

### Observations

An observation is a timestamped event from the conversation.

Shape:

```ts
type Observation = {
  id: string;                 // deterministic 12-character lowercase hex id
  content: string;            // single-line plain prose
  timestamp: string;          // YYYY-MM-DD HH:MM
  relevance: "low" | "medium" | "high" | "critical";
  sourceEntryIds: string[];   // raw/source entries that support this observation
  tokenCount: number;         // estimated content tokens
}
```

Rendered in summaries/views:

```md
[d4e5f6a1b2c3] 2026-01-15 14:30 [high] User decided to switch from REST to GraphQL for the public API; motivation was reducing over-fetching on mobile clients.
```

Observations are written by the observer into `om.observations.recorded` ledger entries. They are factual event records, not durable conclusions.

### Reflections

A reflection is a durable conclusion distilled from observations: user preferences, project constraints, architectural decisions, recurring behavior, or long-lived facts.

Shape:

```ts
type Reflection = {
  id: string;                         // deterministic 12-character lowercase hex id
  content: string;                    // single-line plain prose
  supportingObservationIds: string[]; // evidence observations
  tokenCount: number;                 // estimated content tokens
  replaces?: string[];                // ids of reflections this one replaced
}
```

Rendered:

```md
[a1b2c3d4e5f6] User works at Acme Corp building Acme Dashboard on Next.js 15 with Supabase auth.
```

Reflections are written by the reflector into `om.reflections.recorded` ledger entries. They should be fewer and more durable than observations; the reflector should not turn every observation into a reflection. The reflector receives each active observation with a deterministic coverage tier (`none`, `partial`, or `strong`) so it can review durable facts that are not yet preserved, but coverage is review context rather than a quota or automatic reflection rule.

A reflection's `supportingObservationIds` are downstream dropper coverage evidence. They should include all and only current observations whose durable meaning the reflection preserves with equivalent fidelity. False or inflated support ids can make later pruning look safer than it is.

### Reflection retirement

Reflections are never edited or deleted, but they can be retired. An `om.reflections.dropped` ledger entry is a tombstone for reflection ids: plain retirement when it names no replacement, or replacement when `replacedBy` names the newer reflection, which lists the retired ids in its `replaces` field. A plain retirement may carry a `kind`: `stale`, `duplicate`, `project-instructions` (the reflection only restated the project's context files), or `promoted` (`/om:promote` moved it into the project's `.memory.md`). Entries written by `/om:ground` also carry a `reason`: the repository evidence (file:line or command output) for the retirement or replacement, which `recall` shows.

Retirement is permanent, with one exception: an id retired with kind `project-instructions` or `promoted` is re-activated when a later `om.reflections.recorded` entry records it again, for example after that rule was removed from AGENTS.md. Every other retired id stays retired even if its reflection record appears later. Retired reflections leave active memory: workers never see them, and they never count as dropper coverage. Compaction treats retirements like reflections, so they become visible to the agent only at the next full fold. Recall still resolves a retired reflection, with its replacement and supporting evidence.

### Promoted memory

Reflections belong to one session branch. `/om:promote` moves durable project facts (conventions, gotchas, build and test rules, architecture decisions, the user's preferences about the project) into `.memory.md` at the repository root, which OM adds to the main agent's context files on every prompt (see [`promotedMemory`](configuration.md#promotedmemory)):

```
# Promoted memory

Durable facts promoted from observational memory. `recall <id>` shows the evidence behind a line.

- [55cb78965cbe] Throwaway tmux servers must be addressed with -S <resolved path>, never -L: …
```

The file is OM's: only its `- ` lines are kept when OM rewrites it. A model call picks the facts, merges them with the existing lines and with the project's hand-written context files, and keeps the file within `promoteMaxTokens`. A line promoted unchanged keeps its reflection's id; a rewritten line is recorded as a new reflection that replaces its sources. Every promoted reflection is then retired with kind `promoted`, so it leaves active memory: the facts now reach the agent through `.memory.md`. Removing a line writes nothing to the ledger.

Next to it, `.memory/<id>.md` stores each promoted reflection and everything it links to, transitively (the reflections it replaces and the supporting observations of each): YAML frontmatter with the record's fields and pi session id, the text verbatim, and relative links. `recall` falls back to this store for ids not on the branch. The files are meant to be committed; ids are content hashes, so OM never rewrites one. `/om:promote` removes the `<id>.md` files the new lines no longer link to (listed in the preview; git history keeps them), so `.memory/` holds exactly what `.memory.md` reaches.

### Drops

A drop is a tombstone for observation ids that should no longer be active memory. Drops are written by the dropper into `om.observations.dropped` ledger entries.

Dropping does not delete history. Dropped observations remain recallable from ledger history, but they are not active observations in projections.

## Actors

### Observer

The observer runs asynchronously from `turn_end` when raw/source tokens after the latest observation coverage marker reach `observeAfterTokens`. After a deliberate empty result, it waits for another `observeAfterTokens` of source tokens before retrying the uncovered range.

It receives an oldest-first chunk of raw/source entries, validates source ids, and appends a non-empty `om.observations.recorded` entry. Chunking targets a fixed 60,000 estimated tokens but always includes at least one entry, so a single oversized entry cannot stall coverage. If there is nothing worth recording, it writes no entry and leaves the raw range uncovered.

### Reflector

The reflector runs in the reflect/drop lane from `turn_end` when its raw-token clock reaches `reflectAfterTokens` and the observer is not due.

It reads active observations and active reflections, then appends durable new reflections as `om.reflections.recorded`. Reflections must cite valid supporting observation ids. It never proposes a reflection again once it has been retired, unless it was retired as covered by project instructions.

Both reflector calls also see the session's project context files (AGENTS.md, CLAUDE.md, the global `~/.pi/agent/AGENTS.md`) as reference data under `PROJECT INSTRUCTIONS`. The main agent already reads those files on every call, so a reflection that restates them is paid twice. Crystallize does not record what they already say, but still records facts that correct, update, or contradict them. The observer and dropper never see them. See [`projectContext`](configuration.md#projectcontext).

When that crystallize run records at least one reflection, a second call, the review, looks over all active reflections: those recorded in this run are marked `[new]`, and each shows when it was recorded. Recent observations serve as evidence. The review can retire reflections outright or replace one or more with a single shorter reflection that states the current truth. `[new]` reflections can only be merged into a replacement, never retired outright, except as covered by project instructions. Reflections whose whole durable content the project context files already state are retired with kind `project-instructions`; reflections that add to or correct those files are kept. A replacement records the ids it replaces in `replaces`, and its supporting observations are the union of theirs. When a replacement's text matches an existing active reflection, the replaced ids are retired in favor of that reflection instead of recording a copy. The reflector's coverage annotations describe current support state only; this first coverage-stewardship model does not repair historical coverage on existing reflections that already missed a supporting observation id.

### Dropper

The dropper runs only as post-reflection maintenance: after the reflector's crystallize or review run records something, the dropper may run if the folded active observation ledger is over `observationsPoolTargetTokens`. The dropper can see same-turn new reflections before deciding what to prune.

The dropper can only drop active observation ids. It cannot rewrite or merge observations. Relevance is treated as importance/resistance rather than an absolute lock: `critical` observations are the highest-resistance candidates, but they can be dropped when the model judges that age, reflection coverage, supersession, redundancy, and semantic safety make removal from active memory safe. Its maximum drop count is computed from tokens over target converted to an approximate observation count, and the model may drop fewer or none.

### Compaction hook

The compaction hook runs during `session_before_compact`. When V3 memory exists, it is deterministic and model-free:

- it does not run observer, reflector, or dropper;
- it does not call a model;
- it does not wait for background memory workers;
- it folds/projects ledger state and renders the summary.

If the projection is empty, the hook returns no extension compaction and Pi uses its native summarizer. This preserves pre-cut context instead of persisting an empty summary. Prepared V3 compactions remain effectively instantaneous compared with V2.

## Ledger entries

V3 uses four custom memory ledger entry types:

```ts
om.observations.recorded: {
  observations: Observation[];
  coversUpToId: string;
}

om.reflections.recorded: {
  reflections: Reflection[];
  coversUpToId: string;
}

om.observations.dropped: {
  observationIds: string[];
  coversUpToId: string;
}

om.reflections.dropped: {
  reflectionIds: string[];
  replacedBy?: string;
  coversUpToId: string;
}
```

The compaction hook writes V3 folded details on Pi compaction entries:

```ts
type MemoryDetails = {
  type: "om.folded";
  version: 1;
  fullFold: boolean;
  observations: Observation[];
  reflections: Reflection[];
}
```

Old V2 memory entry/details formats are ignored.

## `coversUpToId`

`coversUpToId` is a progress watermark. It tells V3 where a worker's raw/source-token progress has reached.

It is not:

- source provenance;
- a dependency pointer;
- proof that a later memory ledger entry caused another one.

Source provenance lives on `Observation.sourceEntryIds` and `Reflection.supportingObservationIds`.

Progress counting uses raw/source tokens after the marker. Raw/source entries are `message`, `custom_message`, and `branch_summary` entries; memory ledger entries and compaction entries do not add raw-token progress.

## Visible, full, and drift

V3 distinguishes visible memory, full memory, and the drift between them:

- **Visible memory** — what the latest `om.folded` compaction details made visible to the agent. This is what `/om:view` shows by default.
- **Full memory** — full V3 ledger truth folded at the branch tip. This is what `/om:view full` shows.
- **Drift** — the difference between visible and full memory. Use `/om:status` to inspect visible-vs-full drift.

Visible and full memory can differ intentionally. Background ledger work may happen after the latest compaction, and normal compactions may avoid re-folding reflection/drop effects until full-fold pressure requires it.

## Recall

`recall` is an agent-facing tool, not a search command. It takes a specific 12-character memory id and looks it up in V3 ledger history on the current branch.

Recall can return:

- an observation, marked `active` or `dropped`;
- a reflection plus supporting observations, marked `retired` (with its retirement kind and replacement, when known, e.g. `retired (covered by project instructions)`) if it was retired, and listing the retired reflections it replaced;
- a mixed result if an id collision exists;
- missing/non-source diagnostics when source evidence is unavailable;
- for ids not on the branch, the record from the nearest `.memory/` store (labelled `From project memory`), with its links followed through the store and sources read from the recording session when it is on this machine.

Use recall when compacted memory matters and exact source evidence is needed before acting.

## Relevance tiers

Observation relevance is assigned by the observer:

| Tier | Meaning |
|---|---|
| `critical` | User identity, explicit corrections, hard constraints, completed outcomes, or facts that require the strongest evidence before leaving active memory. |
| `high` | Important decisions, non-trivial technical direction, unresolved blockers, key preferences. |
| `medium` | Useful task-level context and ordinary progress. |
| `low` | Routine status, tool acknowledgements, or details likely re-derivable from nearby context. |

The dropper uses relevance as part of its judgment, but it is not the only signal and it is not a permanent active-memory pin. User assertions, exact decisions, unique identifiers, dated events, errors, and rationale should be preserved unless safely represented by durable reflections or newer memory. Dropping removes observations from active memory, not from ledger history; recall can still recover dropped observations when their ids are known.

## V2 compatibility model

V3 intentionally does not migrate V2 memory. Old V2 settings are ignored, old V2 custom entries/details are ignored, and rollback to V2 after creating V3 ledger entries should be treated as memory reset or visibility loss.

When upgrading from V2, update settings and start a new clean session.

## Glossary

| Term | Meaning |
|---|---|
| Branch | One path through Pi's session tree. V3 memory is branch-local. |
| Ledger | Silent V3 custom memory entries folded from branch root to a point. |
| Observation | Timestamped source-backed event record. |
| Reflection | Durable conclusion backed by observations. |
| Drop | Tombstone that removes an observation id from active memory. |
| Retirement | Tombstone that removes a reflection id from active memory, optionally naming its replacement. |
| Visible memory | Latest folded memory visible to the agent through compaction details. |
| Full memory | Full V3 ledger truth folded at branch tip or another boundary. |
| Full fold | Compaction mode that folds observations, reflections, drops, and retirements through the boundary. |
| Progress watermark | `coversUpToId`; marker used for raw-token progress clocks. |
| Observer | Background agent that records observations. |
| Reflector | Background agent that records durable reflections, then reviews them (retire/replace). |
| Dropper | Background agent that drops active observations by id. |
| Recall | Agent tool for exact evidence behind a memory id. |

## Where to go next

- [how-it-works.md](how-it-works.md) — runtime lifecycle and data flow.
- [configuration.md](configuration.md) — V3 settings and migration table.
- [../README.md](../README.md) — quick start and V2 upgrade notice.
