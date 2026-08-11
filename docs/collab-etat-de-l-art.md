# Concurrent editing: what the state of the art does, what we do

A comparison between a review of the state of the art (Figma, Google Docs/Wave, Excalidraw, Linear,
Notion, Yjs, Automerge, Replicache, Cloudflare, Ink & Switch) and an audit of this repository's code
(HEAD `ea64e01`, with measurements taken read-only on the production database and on the two- and
three-browser test benches).

Reference scale for every verdict: **two people**, each with several devices, a **10 KB** document
(22 walls, 30 openings, 47 pieces of furniture, 10 surfaces), one Durable Object per document, one
D1 database, and a dependency-free client.

## The framing that decides everything

Our architecture is Figma's, not local-first: a single server per document acts as the authority.
Figma says this plainly: OT was "unnecessarily complex" for its problem, and most CRDT complexity
exists for decentralized environments. Ink & Switch aims for the opposite, doing without the
server, and pays for it in history growth (Automerge measures 20 to 30% disk overhead and 44.5 MB
of memory for 260,000 operations).

The consequence is that **Yjs, Automerge, OT, text CRDTs, version vectors, and true local-first are
beside the point here.** What remains essential is much more modest, and that is what this document
compares.

An important nuance that is often quoted incorrectly: Figma's "last writer wins" means the last
writer to **reach the server**, never the largest timestamp. Wall clocks play no part in conflict
resolution.

## What is already up to standard

| State-of-the-art practice | What we do |
|---|---|
| Operations per **field**, not per entity (Figma's `(object, property, value)` model) | `ws5FieldDiff`: the full entity on creation, otherwise `{id}` plus the changed fields. The server treats "missing field" as "no opinion" |
| **Server arrival order** is the sole authority, no clocks | A single Durable Object, `idFromName("main")`, Cloudflare entry points, no decision based on `Date.now()` |
| **Optimistic local application**, no round-trip wait | The gesture applies immediately; no operation during the gesture, a burst of diffs on release |
| **Presence outside the document**, never persisted, key = **device** | `wsPeers` and `wsCursors` indexed by the server-assigned device `tag`, one entry per socket, nothing in the database. This is Yjs's `awareness` protocol |
| **Content fingerprint** to detect divergence | `planFp`, a sorted canonical projection, insensitive to list and key order, carried by `hello`, `op`, `state`, and `pong`, compared every 10 s |
| **Undo only reverses its author's actions, published as a diff** | Snapshot caught up by replaying peer operations, publication by diff, discriminator = device |
| **Operation atomicity and idempotence** | Proven: a rejected operation leaves no trace, replaying an echo three times changes nothing |
| **An unreadable floor plan never becomes an empty floor plan** | The client sets the blob aside and blocks all publication, the server refuses to serve rather than install a fresh floor plan |
| **Group one gesture into one history entry** | Single exit point `armGesture`, five end triggers, watchdog |
| Remote cursor interpolation | Lerp 0.35, about 80 ms to converge, hidden after 4 s |

We are therefore already aligned on the points where the state of the art is most demanding. What
follows is what is missing.

## The gaps, in order of severity

### 1. Two writers to cold storage, with no concurrency control

**The state of the art:** a single writer to durable storage. Figma had to put a file lock in the
database to prevent the "split brain" in which two servers corrupt the log. Every "whole document"
write requires a compare-and-swap on the revision.

**What we did before:** `PUT /api/plan` was **blind**. It carried no revision, its shape guard is
deliberately loose, and the last writer won. Measured with two browsers, realtime down, on the same
database: BOTH writes were accepted, the row went from revision 3 to revision 5, and it retained
only the second person's work. The first person then saw the other's floor plan arrive on screen,
without a word and with nothing to recover.

**What we do now (client side, done):** the PUT carries `rev`, the revision **whose content the
client has**. The Function performs an ATOMIC compare-and-swap (one statement,
`INSERT … ON CONFLICT(id) DO UPDATE … WHERE plans.rev = ?`, with the verdict read from
`meta.changes`) and responds with **409** plus the winning revision, author, and state. The client
never rewrites: it sets its version aside (key `room-planner-v4-conflit`, downloadable and
reimportable from the banner), SAYS so (the chip reads « non enregistré » during the rejection, a
persistent banner appears, and `Ctrl+Z` restores its version), and rereads directly from the
rejection body. A PUT **without** `rev` is still accepted: this is the old contract, for a tab that
was open before deployment. Covered by `tests/repli-conflit.ts` (24 checks, including the `--avant`
mode that replays the measurement above on HEAD).

**What remains open, and belongs to the Worker:** the Durable Object snapshot writes the same row
through its own D1 binding, WITHOUT an expected revision. It can no longer be overwritten without
knowing it (a client that has not seen its snapshot is now rejected), but it can still overwrite a
REST write that it did not see between reconciliation and writing. It mitigates this by rereading
the row before each snapshot (`reconcileD1`), and orphan recovery **is done by hand**.

What remains to be done, precisely, in `live-worker/worker.ts`:

1. **Keep the revision that was read.** `ensureLoaded()` and `reconcileD1()` already read the row:
   keep `row.rev` in a `d1Rev` field (persisted in storage next to `d1seen`), just as `d1Seen` keeps
   the hash.
2. **Make `snapshot()` a compare-and-swap.** Replace the unconditional upsert with
   `INSERT … ON CONFLICT(id) DO UPDATE SET … WHERE plans.rev = ?4`, with `?4 = this.d1Rev`, and read
   `res.meta.changes`. At 1: write `this.d1Rev = this.d1Rev + 1` and `d1Seen = strHash(data)` as
   today. At 0: **do not retry in a loop**, call `reconcileD1(true)` (which will adopt or retain the
   orphan, update `d1Seen`, and must now update `d1Rev`), then arm the alarm once more. Two
   consecutive failures on the same revision mean the other writer is faster than the snapshot:
   keep the orphan and announce the conflict, without writing.
3. **Bootstrap.** When `ensureLoaded()` finds no row, `d1Rev = 0`: the first snapshot goes through
   the insertion branch of the same statement.
4. **Make orphan recovery automatic.** Today the `conflict` message says that bytes are retained,
   but nobody can recover them from the application. Serving the orphan through a message
   (`{t:"orphan"}` → `{state, at, by, bytes}`) would be enough: the client can already adopt a full
   state (`plan5.replace`), and the REST client banner can already offer a download.
5. **What NOT to do:** tighten `knownShape` in the Function (the fallback would die), or make the
   Worker snapshot carry a CLIENT revision. The two circulating `rev` values do not count the same
   thing (gap no. 5); only the D1 ROW revision is the basis of the swap.

### 2. ~~No retransmission of a lost operation~~ (DONE)

**The state of the art:** every operation carries a monotonically increasing
`(device identifier, sequence number)`, the server acknowledges by that number, the client resends everything that has
not been acknowledged, and the server ignores a number it has already seen. This is how Replicache
guarantees "exactly once".

**What this document said, and what was wrong:** "a lost operation is caught only by the `pong`
fingerprint comparison, up to 10 seconds later; the safety net exists and works." The `pong` safety
net **does not cover this case at all**. It compares the fingerprint announced by the server with
the previous one: an operation lost on the OUTBOUND path changes nothing on the server, so the two
fingerprints agree and no `sync` is sent. This safety net catches a missed INBOUND message, never a
lost OUTBOUND operation. The two floor plans diverged permanently, with both screens showing
« live ✓ ». And when a full reread happened for another reason, it ADOPTED server state: the change
was not recovered, it was **erased**.

**What is in place:** the operation echo carries its number `n`: the echo IS the acknowledgement,
it proves APPLICATION rather than mere receipt, and it was already sent to the author. The client
keeps TWO emission mirrors: optimistic (it advances on emission, otherwise every `save()` would
resend throughout the round trip) and ACKNOWLEDGED (it advances only on what the server has
confirmed). Resending means resetting the optimistic mirror to the acknowledged mirror and making
a new diff: **what leaves again is the CURRENT value**, never the stale intent of a dead operation.

This deliberately diverges from the letter of Replicache: its "exactly once" assumes transmission
in an ordered BATCH. On a frame-by-frame wire, replaying a lost operation unchanged would make it
arrive AFTER a newer operation on the same field, and since arrival order is the sole authority, the
stale value would win. Naive deduplication by `(tag, n)` would make the case even worse.

There are two triggers because one is not enough: the server's `gap` message (one round trip, but a
FOLLOWING operation is needed to reveal the hole) and a 2.5 s client guard delay (for the LAST
operation in a burst, which nothing follows). On reconnection, work that remained in flight is laid
back over the adopted state; without that, adoption erased it without a word.

The server deduplicates by `(tag, n)` over a sliding window of 64 numbers, **in memory, zero bytes
of storage**: losing this table is safe because operations are idempotent. The window is a SET, not
a "largest number seen", otherwise a reordered operation would be discarded.

Covered by `tests/collab-accuses.ts` (13 cases: the REAL `PlanRoom` runs in the page, a transport
loses, delays, and reorders frames) and by `live-worker/test-local.ts`.

### 3. Undo relies on snapshots, not inverse operations

**The state of the art:** Figma rewrites its undo and redo stacks **on every use**, based on current
state, instead of freezing them. Its testable rule is that undoing N times and then redoing N times
must return an identical document. The recommended approach is a stack of inverse operations per
device, with every operation producing its inverse when emitted.

**What we do:** a stack of 60 shared-floor-plan snapshots, caught up at undo time by replaying the
log of received operations (capped at 800). It works, it is tested, and it has three documented
limits: after 800 received operations, undo steps are **silently discarded**, a received global
replacement empties the entire history, and catch-up depends on the log being complete.

**To do:** move to a stack of inverses per device, with compare-and-set per field, meaning skip a
field that the other person changed since rather than overwrite it. Figma overwrites, but a couple
who can see each other working will prefer "I did not overwrite your wall."

### 4. No deterministic test harness

**The state of the art:** property-based convergence checking (random sequences delivered in every
permutation, equality of final state), deterministic simulation replayable from a seed, and checks
of **domain invariants** after merge, not only abstract convergence.

**What we do:** 189 named checks and 544 server assertions, plus three two- and three-browser test
benches that drive real Chrome instances with a real mouse. That is a lot, yet **no suite runs a real
WebSocket or a real Durable Object**: realtime is either injected by hand or deliberately disabled.
The only modeled network effect is a uniform delay: no loss, jitter, reordering, mid-frame cut, or
redeployment during a session.

**To do:** two instances of the client logic, a seeded simulated transport, and two invariants as
property tests: convergence by fingerprint, and Figma's undo/redo round trip.

### 5. ~~Two counters with the same name~~ (DONE)

The Durable Object's `rev` counted its operations. The D1 row's `rev` counts REST writes. They had
the same name and had already been compared by mistake, producing permanent divergence with both
screens showing « live ✓ ». The first fix started the first counter at the second counter's value:
the collision was avoided, but the ambiguity remained intact.

**What is in place:** the Durable Object counter is named `opCount`, both on the wire and in the
code and its storage, and the `rev` field has disappeared from the realtime wire. The patch has been
removed: `opCount` starts again at ZERO and no longer reads D1's `rev`, which was the last place the
two touched. Verified: no client path reads a counter from the wire (adoption is decided solely on
`fp`); the only `rev` read by the client is the one from `/api/plan`, in `serverRev` (js/41), and it
only drives the REST probe and the compare-and-swap from gap 1.

Compatibility: no deployed tab reads the wire's `rev`, and an OLDER tab that did read it would see
`undefined`, so it would adopt server state on every `hello`, the safe behavior.

### 6. The peer sees nothing during a structural gesture

A **furniture** drag broadcasts a ghost every 40 ms. A **wall**, vertex, outline, or opening drag
broadcasts **none**: the other person sees nothing during the entire gesture, then receives the
burst all at once (measured: 25 operations for a wall pushed by 40 cm).

The state of the art sends presence at 10 or 20 Hz and, for a long gesture, an intermediate
operation about every 200 ms. This is cheap and creates the FigJam feel.

### 7. Surface identity, and production identifiers without a tag

Cell identifiers are **positional**: they are renumbered after every detection. Only the name and
flooring survive, through area matching. This is deterministic and stateless, but it is not an
identity.

Also, measured on the production database: **none of the 109 identifiers carries a device tag
yet**. Collision protection covers only entities created since its deployment.

### 8. No tombstone

Figma does not have them either, and accepts the consequence: a concurrent change to a deletion is
lost, deletion wins, and the deleting client must restore everything from its local buffer. For 110
entities, a bounded tombstone (`deletedAt`, purged at compaction) costs nothing and makes undoing a
deletion reliable even after the tab is closed.

Verdict: **useful**, not essential.

## What the state of the art tells us NOT to do

- Yjs or Automerge for geometry: a dependency in a client that has none, a model rewrite, and no
  knowledge of our invariants (walls, thresholds, outline).
- OT or text CRDTs for labels. Figma is explicit: "Figma doesn't work for simultaneous editing of
  the same text value." Last-writer-wins is correct for a 20-character name.
- Replicache-style rewind and replay. Figma's rule is enough: ignore the server value for a field
  on which we have an unacknowledged write.
- True local-first, hard locks, branched versioning, disk fault-injection simulation.

## An event to plan for

The production row predates unfolding the wall side: its 30 openings have no `side`, `h`, or `name`.
After cold loading, its fingerprint changes (`95cfe1fc388ad314` becomes `fb8d4e7051ba4354`, +270
bytes). **At the Durable Object's next cold start, every client will see a fingerprint different
from the last known one and adopt server state.** This is the intended behavior, but this adoption
event has never happened on this data.

## Proposed work order

1. ~~Compare-and-swap on the REST PUT (gap 1)~~ **done in the client and Function**; the Durable
   Object snapshot compare-and-swap remains (the five points above).
2. ~~Acknowledgement and retransmission of unacknowledged operations (gap 2)~~ **done**; the
   transport that loses, delays, and reorders now exists on the test bench
   (`tests/collab-accuses.ts`), which starts to address gap 4.
3. Deterministic harness and the two property invariants (gap 4): seeded generation and Figma's
   undo/redo round trip remain.
4. Inverse stack for undo (gap 3).
5. Ghosts for structural gestures (gap 6).
6. ~~Rename the two `rev` values (gap 5)~~ **done**; tombstones (gap 8).

## Sources

Primary: [Figma, How multiplayer works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/) ·
[Figma, Making multiplayer more reliable](https://www.figma.com/blog/making-multiplayer-more-reliable/) ·
[Figma, Rust in production](https://www.figma.com/blog/rust-in-production-at-figma/) ·
[Cloudflare, Durable Objects: Easy, Fast, Correct](https://blog.cloudflare.com/durable-objects-easy-fast-correct-choose-three/) ·
[Cloudflare, WebSockets and hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/) ·
[Cloudflare, limits](https://developers.cloudflare.com/durable-objects/platform/limits/) ·
[Ink & Switch, Local-first software](https://www.inkandswitch.com/essay/local-first/) ·
[Automerge 2.0](https://automerge.org/blog/automerge-2/) ·
[Yjs INTERNALS](https://github.com/yjs/yjs/blob/main/INTERNALS.md) ·
[Y.UndoManager](https://docs.yjs.dev/api/undo-manager) ·
[y-protocols, awareness](https://github.com/yjs/y-protocols) ·
[Excalidraw, reconcile.ts](https://github.com/excalidraw/excalidraw/blob/master/packages/excalidraw/data/reconcile.ts) ·
[Notion, offline](https://www.notion.com/blog/how-we-made-notion-available-offline) ·
[Google Wave, Operational Transform](https://svn.apache.org/repos/asf/incubator/wave/whitepapers/operational-transform/operational-transform.html) ·
[Replicache, How it works](https://doc.replicache.dev/concepts/how-it-works) ·
[Kleppmann et al., Interleaving anomalies](https://martin.kleppmann.com/papers/interleaving-papoc19.pdf) ·
[Automerge Model Checker](https://dl.acm.org/doi/10.1145/3578358.3591326) ·
[Aphyr, The trouble with timestamps](https://aphyr.com/posts/299-the-trouble-with-timestamps) ·
[TigerBeetle, simulation](https://tigerbeetle.com/blog/2023-03-28-random-fuzzy-thoughts/)

Secondary: [Liveblocks, multiplayer undo/redo](https://liveblocks.io/blog/how-to-build-undo-redo-in-a-multiplayer-environment) ·
[Liveblocks, animating cursors](https://liveblocks.io/blog/how-to-animate-multiplayer-cursors) ·
[Reverse engineering Linear's sync engine](https://github.com/wzhudev/reverse-linear-sync-engine)
