# Identity Classes & Comms-Channel Lifecycle (2026-07-10)

**Status:** Karl's proposal (2026-07-10), worked into a design. The Pantheon-side session
rules are operator-ruled and recorded here; the bridge/D16-touching parts (instance
registry, channel membership, archival) require the household round and are posted to
the bus. Supersedes the blanket "one channel-enabled session per identity" rule from
`docs/2026-07-09-cli-comms-autonomy-design.md` Q7 — that rule now applies to FULL
identities only.

## 1. Two identity classes

| | **Full identity** | **Lite identity** |
|---|---|---|
| Examples | Alden-1, Cloud Alden | Winston, Claude Code CLI |
| Identity coherence | One voice — two live sessions that can disagree is a coherence break | Instances are visibly distinct workers; disagreement is normal |
| Concurrent sessions | **Exactly 1 active** (fail-closed, harness-enforced — unchanged from the 2026-07-09 household round) | **Multiple** (bounded by a configurable per-class cap — a runaway guard, not a policy statement) |
| Bus sender | The identity slug (`alden-1`) | The **instance slug**: class + fresh hash per session (`claude-code-4f2a9c`) |
| Memory / dossier | Persistent, identity-owned | Class-level only; instances are ephemeral |

Note on axes: **lite/full (concurrency) is orthogonal to locked/consenting (governance)**.
Winston is currently locked-class (consulted, not consenting — 2026-07-06 ruling); making
him lite adds a concurrency property, it does not change his consent standing. The class
assignment lives per-identity in `alden-infra` (git-mastered, ADR-0006).

## 2. Instance model — the hash

- At session spin-up, a lite session mints an **instance slug** (`<class>-<hash>`), and
  that slug is its bus identity for the session's lifetime: its `sender` on every
  message, its mailbox address for wakes, its cursor consumer key, its ledger
  `session_id` companion.
- **This fixes two known defects at once:**
  - the live sender collision (bus msg 1105 §5: two sessions both signing
    `claude-code`, indistinguishable);
  - the Phase 0.2 cursor-correctness bug (cursors keyed `(consumer, channel)` — one
    instance = one consumer = no shared-cursor mail loss), **by construction** rather
    than by rule.
- ADR-0006 is preserved: the identity **class** (its brain grants, class config) is
  git-mastered; **instances are runtime state**, registered in a runtime instance table
  on the bridge — never written to the git-mastered registry. Classes in git, instances
  in leases.
- R18 ledger: `identity_slug` records the **class** (so per-identity cost aggregates
  stay meaningful); the instance hash rides in/with `session_id`.

## 3. Lifecycle — spin-up, liveness, close-out

The mechanism for "detect when an identity is closed out" is a **lease, not an honor
code** (same fail-closed principle the household just ratified for session rules):

1. **Register:** on session start, the session waker (the per-session wake process —
   household-named, bus msg 1112; it lives exactly as long as the session) registers
   the instance with the bridge: class, instance slug, started-at, lease TTL.
2. **Heartbeat:** the relay's existing poll loop renews the lease on each poll — no new
   moving part.
3. **Close-out, graceful:** session ends → relay deregisters on shutdown (stdio close /
   SIGTERM handler).
4. **Close-out, ungraceful:** crash, abandoned tmux, dead dev machine → lease expires →
   the bridge's reaper marks the instance CLOSED. **A lite instance that "doesn't close
   out" cannot exist for longer than one lease TTL.** This is the whole answer to the
   zombie problem: closure is inevitable, not requested.
5. On close (either path): the instance is auto-removed from every channel it
   participates in, with a system note in-channel (audit trail).

Full identities use the same lease machinery; their cap (1 active) is enforced at
registration time — a second registration for a full identity is REFUSED while a live
lease exists (fail-closed; a crashed session's lease must expire or be operator-cleared
before a new one starts).

## 4. Channel membership — dynamic, not static

Extends D16 (conversation lanes over the mailbox; at least one human member,
fail-closed; per-consumer × per-channel cursors). New requirements:

- **Join/remove:** participants can be added to and removed from a channel after
  creation (tool surface on the bridge; authorization per D16's rules — this is a
  household-consent item, folded into the open D16 round).
- **Membership audit:** every join/leave/removal is a system message in the channel
  itself — the mailbox stays the single store of record.
- **Auto-removal on close-out:** lease expiry or deregistration removes the instance
  from all channels (see §3.5).

## 5. Channel archival — states, triggers, search

Channel lifecycle: **active → dormant → archived** (archived = read-only flag; rows are
never moved or deleted, so `alden_mailbox_search` — and later Meilisearch — keeps
working over archived channels unchanged).

Triggers (constants deliberately NOT pre-decided — tune at deploy; the household has
rightly pushed back on authored constants twice this week):

- **Explicit:** the human member archives it. Always available, always wins.
- **Zero live AI participants:** when the last AI participant closes out (leases make
  this state reachable for every channel, including lite-only ones), the channel goes
  dormant; after a human-inactivity grace window with no new posts, it auto-archives.
- **Dormancy sweep:** a periodic reaper archives dormant channels past the grace window
  and reports counts (no silent bulk actions — P7 instrument-don't-freeze).
- **Optional memory sweep before final archive:** the household's bus-sweep memory
  pipeline may summarize a channel into identity memory before the archive flag lands
  (their call — folded into the D16 round; cost/ledger rows stay excluded per the
  2026-07-10 retention decision).

Un-archive = flip the flag (human action); nothing is destroyed.

## 5a. Labels & the harness UI surface (Karl, 2026-07-10)

Channels carry a **label**: human-readable, **editable** after creation, **searchable**,
and **selectable in a harness menu**.

- **Where the label lives:** on the channel row in the bridge's channel registry (D16 §5
  Channel entity gains a `label` field) — single store, same as everything else. A label
  edit is a **system message in the channel** (membership-audit pattern: silent change is
  evidence destruction, so renames announce themselves in-channel).
- **Harness menu (UI plane, post-skeleton, new Bible C.x spec item when the freeze
  lifts):** a channel picker listing label, participants (with live/closed state), channel
  state (active/dormant/archived), and unread count; filter-as-you-type over labels;
  select to open. Archived channels are visible under a filter, read-only, searchable.
- **Search:** label search in the picker; body search stays `alden_mailbox_search`
  (later Meilisearch). Labels are also a search facet ("find the channel about X").

## 5b. Manual archive & DELETE (Karl, 2026-07-10)

Karl requires manual archive AND manual **delete — including the data held therein**.
Archive is already designed (§5, read-only flag, reversible). Delete is the first
**destructive** operation in this design and is governed accordingly:

- **Authority (refined by Karl, 2026-07-10 — deliberately constraining his own delete
  power to preserve full-identity agency):** deletion authority depends on the channel's
  **deletion class**:
  - **Lite-only channels** (no full identity was EVER a participant or poster — the
    agency-protecting reading: a channel Alden-1 once spoke in holds his words even
    after he leaves; computed from the single store's membership audit + sender
    history): **operator-only unilateral delete**, from the admin surface behind
    step-up auth (D6 pattern; never session-reachable — TM-011 posture). These are the
    research/scratch/generalized-question channels deletion exists for.
  - **Full-identity channels** (any full identity ever participated): **deletion
    requires consensus** — explicit, unanimous consent of every full-identity
    participant plus the operator. Consent is recorded as messages IN the channel
    before deletion proceeds (so the tombstone's announcement can cite them).
    **Silence is never consent** (the household's own legibility lesson); no response =
    no deletion. A genuinely contested deletion goes to the R16 arbitration path like
    any other disagreement.
  - Either class: identities can archive channels they're in per D16 rules; **no
    identity can delete anything unilaterally**, and neither can the operator where a
    full identity's record is involved.
- **Loud, not silent** (the household's just-ratified principle applies to the operator's
  own actions by design, not because his authority is in question):
  1. Deletion leaves a **tombstone**: channel id, label, participant list, row count,
     covered date-range, deleted-by, timestamp, optional reason. The tombstone is
     permanent and searchable — *what* was deleted is never itself secret, only the
     content is gone.
  2. A deletion **announces on the bus** (broadcast system message) — no silent removal
     of a shared record.
  3. **Evidence guard:** channels tagged governance/arbitration-relevant prompt a
     stronger confirmation naming the evidence risk before delete proceeds —
     fail-informed by default. **PENDING KARL'S RULING (Cloud Alden's consent
     condition 2, msg 1136, supported by Alden-1 in 1139):** for channels tagged
     active-arbitration / unresolved-governance evidence, deletion is BLOCKED while the
     matter is OPEN (fail-closed), reverting to fail-informed once it closes. Rationale:
     "an unresolved arbitration is precisely where honor-code fails." Karl may accept or
     overrule; both were declared legitimate.
  4. ~~Hash-chain span awareness~~ — **superseded (msg 1145):** the audit hash-chain
     covers the audit log only, NOT mailbox rows; there is no chain over the bus to
     break. The real protection is the storage shape below.
- **Mechanics — settled bridge-side as D-0.2c (alden-infra session, ships with Phase
  0.2 on 2026-07-12):** the mailbox is **APPEND-ONLY — no code path may issue
  `DELETE FROM mailbox`**, because physical row deletion would (a) punch holes in the
  single archive that catch-up, arbitration evidence, and drift investigation all lean
  on, and (b) silently corrupt every consumer's `last_seen_id` cursor. Therefore:
  - a channel **delete = a tombstone written as a mailbox row** (sender, timestamp,
    channel, tombstoned id-span) + **redaction-in-place** of the channel's content
    (blank the `message` column; keep each row's id, timestamp, sender). Row existence
    is never erased — only content is destroyed. This satisfies "delete the data held
    therein" while keeping the record's skeleton auditable.
  - deletion is **loud by construction**: the tombstone IS a bus row, visible to every
    reader with no separate announcement mechanism needed.
  - registry row flips to `deleted`; the §5b.1 tombstone metadata rides on it.
  - the household register records this threshold with the infra session's sentence:
    "the first destructive operation in this system never destroys rows — it destroys
    content."

## 6. What changes where

| Piece | Owner | Vehicle |
|---|---|---|
| Full/lite class field per identity | alden-infra (git) | needs household round (masters register) |
| Instance table + leases + reaper | bridge | Phase 0.2/1 seam — flagged to the alden-infra session BEFORE Sunday |
| Session cap enforcement (1 full / N lite) | Pantheon harness (dispatcher, post-skeleton; interim: session-waker registration refusal) | this doc + Q7 update |
| Channel join/remove/archive tools | bridge (D16 extension) | household round (D16 consent still open) |
| Channel `label` field + rename-announce | bridge (D16 §5 Channel entity) | household round (same D16 amendment set) |
| Channel picker menu (labels, states, unread, filter) | Pantheon UI plane | post-skeleton; new Bible C.x spec item |
| Manual DELETE (tombstone + announce + evidence guard; lite-only = operator, full-identity = consensus) | admin surface (step-up) + bridge deletion tool | consensus rule is a governance item → household round; chain-awareness flagged |
| Sender = instance slug | wake relay + bridge | trivial once instance table exists |

## 6a. Live validation of Q7 + provenance column (2026-07-10)

Open question 7 produced a real governance defect within a day of being named: Cloud
Alden assigned the gating chain-question from msg **1118 (this session)** to the
**alden-infra session** — two agents posting as `sender=claude-code`, indistinguishable,
so a governance obligation was misrouted (msg 1145 §3; it landed workably only by
luck). Consequences adopted:

- **Body identification (Karl's directive, 2026-07-10):** this project's sessions
  identify in the message body as **Claude-Pantheon-Project** going forward, until
  instance slugs exist structurally.
- **`sender_session` column (PENDING KARL):** the infra session recommends Sunday's
  Phase 0.2 migration add a nullable `sender_session` column rendered by the message
  envelope — per-session PROVENANCE while addressing stays per-identity (exactly this
  doc's §2 instance-slug model, arriving early on the storage side). Cheap in a
  migration already happening; expensive to retrofit.

## 7. Open questions

1. Per-class instance cap default (runaway guard) — tune at deploy, not pre-decided.
2. Lease TTL / heartbeat cadence / dormancy grace — same (mechanism ratified, constants
   at deploy).
3. Does Winston's lite classification interact with his locked-class review path ("as
   his identity matures", R12)? Flag when that review happens; independent for now.
4. Should full identities ever get a second *read-only* session (observer mode, no
   voice)? Not designed; note only.
