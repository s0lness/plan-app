# Deploying the `plan-live` Worker (REST, without wrangler)

This machine has no wrangler (win32-arm64). Everything goes through the Cloudflare REST API with
`CLOUDFLARE_API_TOKEN` (see `~/projects/.secrets.env`). The token must have the following scopes:
Workers Scripts:Edit, Workers Routes:Edit, D1:Edit, and Durable Objects (included in Workers Scripts:Edit).

Constants:

- `account_id`: `<account_id>` (Cloudflare dashboard, right sidebar of any zone overview page, or
  `GET /accounts` with your API token).
- D1 `DB` id: `<d1_database_id>` (dashboard under Workers & Pages > D1, or `GET
  /accounts/{account_id}/d1/database`).
- zone id: `<zone_id>` (dashboard, right sidebar of the zone overview page, or `GET /zones`).
- script: `plan-live`, built entry module `worker.mjs`, DO class `PlanRoom`.

The `worker.ts` and `ops.ts` sources are bundled by `npm run build:worker` into `dist/worker.mjs`.
**Only one JavaScript module is uploaded**: `ops.ts` is included in the bundle. The Workers API
does not compile TypeScript and rejects a direct upload of `.ts` source. Building before every
upload is therefore a deployment requirement.

---

## 1. Upload the script (multipart PUT)

`PUT /accounts/{account_id}/workers/scripts/plan-live`

Metadata JSON:

```json
{
  "main_module": "worker.mjs",
  "bindings": [
    { "type": "d1", "name": "DB", "id": "<d1_database_id>" },
    { "type": "durable_object_namespace", "name": "ROOM", "class_name": "PlanRoom" }
  ],
  "migrations": { "new_tag": "v1", "new_sqlite_classes": ["PlanRoom"] },
  "compatibility_date": "2026-07-01"
}
```

**Use `new_sqlite_classes`, not `new_classes`.** The free plan only allows Durable Objects backed
by SQLite. `new_classes` (classic DO, KV backend) fails during creation. The production namespace
does use SQLite (`GET /accounts/{acct}/workers/durable_objects/namespaces` returns
`use_sqlite: true` for `plan-live_PlanRoom`), and the applied migration tag is `v1`
(`GET .../workers/scripts/plan-live/versions/{id}` -> `resources.script_runtime.migration_tag`).

`_meta.json` (next to this file) is the REDEPLOYMENT metadata. It intentionally does NOT contain
a `migrations` block. Use it for routine deployments.

### PowerShell (curl.exe, recommended for multipart)

First, build from the repository root:

```powershell
npm run build:worker
```

`curl.exe` handles `multipart/form-data` cleanly with a content type for each part. The single file
part MUST have a `filename` that matches the name referenced in the metadata (`worker.mjs`) and use
the `application/javascript+module` type. The part name is the BUILT module name, not the source
name. The metadata part is named `metadata` and uses `application/json`.

```powershell
# load the token
$env:CF = (Select-String -Path "$HOME\projects\.secrets.env" -Pattern '^CLOUDFLARE_API_TOKEN=').Line -replace '^CLOUDFLARE_API_TOKEN=',''
$acct = "<account_id>"
$dir  = "live-worker"   # run from the repository root

# metadata in a temporary file (avoids quoting issues)
$meta = @'
{"main_module":"worker.mjs","bindings":[{"type":"d1","name":"DB","id":"<d1_database_id>"},{"type":"durable_object_namespace","name":"ROOM","class_name":"PlanRoom"}],"migrations":{"new_tag":"v1","new_sqlite_classes":["PlanRoom"]},"compatibility_date":"2026-07-01"}
'@
Set-Content -Path "$dir\_metadata.json" -Value $meta -Encoding utf8 -NoNewline

curl.exe -X PUT `
  "https://api.cloudflare.com/client/v4/accounts/$acct/workers/scripts/plan-live" `
  -H "Authorization: Bearer $env:CF" `
  -F "metadata=@$dir\_metadata.json;type=application/json" `
  -F "worker.mjs=@$dir\dist\worker.mjs;type=application/javascript+module"

Remove-Item "$dir\_metadata.json"
```

Expected response: `{"success":true,...}`. If it fails, read `errors[].message`.

### DO migration note

`migrations.new_tag:"v1"` + `new_sqlite_classes:["PlanRoom"]` is valid only for the **first**
deployment of the class. It has ALREADY been applied (current tag `v1`). For a **redeployment**
(changed code, class already created), REMOVE the `migrations` block from the metadata, or the
deployment fails with "migration tag v1 already applied". A redeployment with no class changes
does not need a migration. This is exactly what `_meta.json` does.

Redeploy with one command (metadata is ready, no temporary file to write):

```powershell
$env:CF = (Select-String -Path "$HOME\projects\.secrets.env" -Pattern '^CLOUDFLARE_API_TOKEN=').Line -replace '^CLOUDFLARE_API_TOKEN=',''
$acct   = (Select-String -Path "$HOME\projects\.secrets.env" -Pattern '^CLOUDFLARE_ACCOUNT_ID=').Line -replace '^CLOUDFLARE_ACCOUNT_ID=',''
$dir    = "live-worker"   # run from the repository root

npm run build:worker

curl.exe -X PUT `
  "https://api.cloudflare.com/client/v4/accounts/$acct/workers/scripts/plan-live" `
  -H "Authorization: Bearer $env:CF" `
  -F "metadata=@$dir\_meta.json;type=application/json" `
  -F "worker.mjs=@$dir\dist\worker.mjs;type=application/javascript+module"
```

A deployment WAKES the Durable Object with the new code. The running instance is recycled, open
WebSockets are disconnected, and clients reconnect using their backoff. State is not lost (DO
storage + D1 snapshot), but the reconnection is visible. Deploy when nobody is editing.

The D1 snapshot is handled by a **storage alarm** (`setAlarm` / `alarm()`), not by `setTimeout`.
It is persistent, so a snapshot due at deployment time survives the instance recycle and runs
when the instance wakes. No special action is needed before deployment.

### D1 database

The application schema (`plans`, `errors`) is in `schema.sql`, next to this file. The production
database already exists. This file is only used to recreate an identical database.

---

## 2. Zone route (POST)

The client connects to `wss://plan.<your-domain>/ws`. Route only `/ws*` to the Worker. Pages
continues to serve the rest of the domain.

`POST /zones/<zone_id>/workers/routes`

```powershell
$body = @{ pattern = "plan.<your-domain>/ws*"; script = "plan-live" } | ConvertTo-Json
Invoke-RestMethod -Method Post `
  -Uri "https://api.cloudflare.com/client/v4/zones/<zone_id>/workers/routes" `
  -Headers @{ Authorization = "Bearer $env:CF" } `
  -ContentType "application/json" -Body $body
```

Response: `{"success":true,"result":{"id":"<ROUTE_ID>",...}}`. **Record `ROUTE_ID`** for rollback.

A zone route takes precedence over Pages for the given pattern. `plan.<your-domain>/ws*` captures
only URLs starting with `/ws`, so `index.html` and `functions/api/plan.ts` are not affected.

---

## 3. Verify (without an account)

Cloudflare Access is in front of the service. A plain HTTPS GET (without a WebSocket upgrade) to
`/ws` must be intercepted by Access and return a login redirect (302) or 403, NOT a Worker 404/426.

```powershell
# must return 302 (Access redirect) or 403: proves that Access protects the route
curl.exe -sS -o NUL -w "%{http_code}\n" -A "test" "https://plan.<your-domain>/ws"
```

- `302`/`403` => Access protects the route (expected).
- `426`/`404` => Access does NOT cover `/ws`: add the `/ws*` path to the Access application for
  `plan.<your-domain>` (otherwise the Worker would be reachable without authentication).

A real WebSocket functional test requires an Access JWT, which means an authenticated browser
visit. It cannot be scripted here without a service token (the API token cannot create an Access
service token, see AGENTS.md).

---

## 4. Rollback

```powershell
# delete the route (returns /ws to Pages; realtime CONTINUES through functions/ws.ts, see note below)
Invoke-RestMethod -Method Delete `
  -Uri "https://api.cloudflare.com/client/v4/zones/<zone_id>/workers/routes/<ROUTE_ID>" `
  -Headers @{ Authorization = "Bearer $env:CF" }

# (optional) delete the script. Warning: this also destroys the DO instance and its storage.
# The D1 snapshot remains the source of truth, so no floor plan data is lost.
# Invoke-RestMethod -Method Delete `
#   -Uri "https://api.cloudflare.com/client/v4/accounts/$acct/workers/scripts/plan-live?force=true" `
#   -Headers @{ Authorization = "Bearer $env:CF" }
```

**Warning: deleting the route is NOT enough to turn off realtime.** The client connects to `/ws`
on its own origin, and Pages answers through `functions/ws.ts`. It has the SAME `ROOM` binding to
the `plan-live_PlanRoom` namespace and forwards the upgrade to the same Durable Object. Without a
zone route, traffic simply goes through Pages and realtime continues. To turn it off completely,
remove `functions/ws.ts` (or its `ROOM` binding) and redeploy Pages.

The REST fallback is now complete in both directions: `functions/api/plan.ts` accepts the
WALLS-ONLY form (flat `outline` / `walls`) in addition to the old form (`rooms`), so both tabs can
read AND write during fallback. What the Durable Object does with these writes is described below.

---

## 5. The realtime wire, and what the Durable Object guarantees

### Messages (server -> client)

| message | contents | purpose |
|---|---|---|
| `hello` | `you:{email,color,tag}`, `peers:[{email,color,tag}]`, `state`, **`opCount`**, `fp`, **`acks`**, `chat` | full state on arrival; `acks:true` = this server sends acknowledgements |
| `op` | `op`, `by`, **`tag`**, **`n`**, **`opCount`**, `fp` | echoes an op to EVERYONE (including the sender). `tag`+`n` make it the ACKNOWLEDGEMENT for its author |
| `ack` | **`n`**, **`tag`**, `opCount`, `fp`, `dup:true` | number already processed: nothing is replayed, but the acknowledgement is still sent |
| `gap` | **`tag`**, **`need`**, **`n`** | a number from this device is missing: an op was lost in transit and the device must resend it |
| `state` | `state`, **`opCount`**, `fp`, `reason` | full state outside `hello` (`reason` = `sync` or `d1_adopt`) |
| `conflict` | `by`, `at`, `bytes`, `kept` | a REST write could not be merged and is preserved |
| `pong` | `ts`, `fp` | heartbeat and current fingerprint |
| `peer` | `peers:[{email,color,**tag**}]` | presence is a list of DEVICES, not people |
| `cursor`, `drag` | `by`, **`tag`**, `color`, … | relayed unchanged, with the authoring device |
| `err` | `reason`, **`n`**, **`kind`** | `n` = the rejected op number (returned exactly as the client sent it, `null` if none was provided) |
| `chat` | unchanged | |

Client -> server messages: `hello`, `op`, `cursor`, `drag`, `chat`, `ping`, and **`sync`**
(requests the full state without closing the socket).

### `fp`: the content identity to compare INSTEAD of any counter

The Durable Object's op counter is named **`opCount`**. The `rev` read by the client from
`/api/plan` counts writes to the D1 row. **These were unrelated counters with the SAME name that
cycled through the same small integers**. When they matched, the client concluded "nothing new"
and kept stale state forever while showing the "live ✓" chip. The first patch (starting one from
the other's value) has been removed: `opCount` starts again at zero and never reads D1's `rev`.
`fp` (16 hexadecimal characters, see `planFp` in `ops.ts`) depends ONLY on content. List order and
key order do not matter.

### Acknowledgement: `(tag, n)`, an in-memory window, zero storage bytes

The op echo contains `n`, so its author knows which op arrived. PER SOCKET, the server keeps a
sliding window of 64 processed numbers (`PlanRoom.seq`, key = `tag`):

- number already in the window -> **nothing is replayed**, but an `ack` is still sent (without it,
  the author would think the change was lost and resend it forever);
- number greater than the highest seen + 1 -> the op is still applied (arrival order remains the
  only authority) AND a `gap` is sent: a number was lost;
- a REJECTION consumes the number just like an acceptance: the client received its answer in both cases.

The window is a **set**, not just a "highest number seen". When messages are reordered, a valid op
that arrives late would otherwise look like a duplicate and be DROPPED. It lives **in memory only**
and dies with the socket. Persisting it would cost a storage write on the hottest path for a table
whose loss has no consequences (ops are idempotent, and the client never resends an op as-is, only
a diff to its current value).

Client rule: keep the LAST fingerprint received from the server (`hello`, `op`, `state`) and, on
`hello`, adopt the state as soon as it differs from `msg.fp`. Never recalculate the fingerprint locally.

### `tag`: the device label, sent everywhere

A 6-character hexadecimal string, unique among LIVE sockets (two tabs belonging to the same person
receive different values), stable for the lifetime of the socket. It has two uses:

1. suffix for client entity identifiers, so two simultaneous creations no longer collide
   (`you.tag`, already implemented);
2. the **TECHNICAL IDENTITY of the realtime wire**. It now accompanies `peer`, `op`, `cursor`, and
   `drag`. Without it, the client made every decision using `by === my email`, so a second device
   belonging to the same person (the computer and phone are behind one Access identity) was treated
   as itself. Its ops did not enter the undo replay log (one Ctrl+Z destroyed its work on both
   screens AND in the server floor plan), and its dot, cursor, and drag ghosts did not appear.
   `by` remains the HUMAN identity (the displayed name).

### `n`: the op number, so a rejection identifies WHICH ONE

The client sends diffs and marks the value as acquired immediately after sending. A rejected op is
never sent again. Without knowing which one, the client kept the change on screen, the chip stayed
"live ✓", and both devices diverged permanently (measured: 33 openings on one side, 33 on the
other, not the same ones, and 30 on the server). The client therefore numbers each `{t:"op"}` with
an integer `n` local to its socket, and the server returns it in `err` (with `kind`). `n` is never
persisted, never sent to peers, and is `null` if the client did not provide it.

### Reconciliation with D1

The DO rereads ITS OWN row (`planId`, reread from storage on every wake-up, never assumed to be
`main`) only when it could otherwise destroy a write it did not make: when the room becomes
occupied after being empty, and before every snapshot (alarm, flush after the last departure). The
discriminator is `updated_by`: the DO never writes anything other than `live`, and the REST
Function never writes `live`.

- foreign row + idle DO -> **adoption**, plus a `state` message (`reason:"d1_adopt"`);
- foreign row + active DO (alarm armed) -> **conflict**: realtime state is kept, the foreign bytes
  are appended to the `orphans` list, and a `conflict` message is sent to all connected clients.

The snapshot itself is a **compare-and-swap**: it writes
`INSERT … ON CONFLICT(id) DO UPDATE … WHERE plans.rev=?`, with the revision the reconciliation just
read, and reads its verdict from `meta.changes`. Zero rows touched means a PUT landed between the
two round trips: the DO reconciles once more (adopting it, or setting it aside as an orphan and
telling the clients) and retries exactly once. It no longer overwrites a fallback write it never saw.

### Recovering a version set aside (`orphans`)

The last **5** discarded versions are kept, oldest first, and are read back over the DO's internal
route rather than by opening its storage by hand:

```
GET /orphans   on the PlanRoom stub, header X-Plan-Internal: 1
-> {"orphans":[{"at":…,"by":…,"rev":…,"data":"<the JSON state>"}]}
```

Same guard and same reachability as `/revoke`: it is called over the `ROOM` binding from a Pages
Function, never from the network-facing `fetch` (which serves `/ws` only). The Function side that
exposes it to the household door is `/api/orphans`. A version whose bytes exceeded the storage
ceiling is listed with `data: null`: the trace is kept even when the content could not be.

### Deleting a plan (`purge`)

Deleting the D1 row is not enough: the DO would snapshot the row straight back
(`INSERT … ON CONFLICT`), and its sockets would stay open on a plan that no longer exists.

```
POST /purge    on the PlanRoom stub, header X-Plan-Internal: 1
-> {"ok":true,"closed":<number of sockets closed>}
```

It closes every socket with code **4004** / `plan_deleted`, disarms the alarm, erases the storage,
and leaves a `purged` marker so a late message on a straggling socket is refused without rewriting
anything (and a later upgrade answers **410**). Call it from the DELETE that removes the row.

DO storage keys: `planId` (WHICH row is this object's own), `plan`, `rev`/`opCount`, `chat`,
`d1seen` (fingerprint of D1 bytes already written or adopted), `orphans` (the last 5 unmerged REST
writes), `purged` (the plan was deleted).

### Client/server deployment order

**Server first, client second.** All server additions are additive. A tab still running the old
client ignores `fp`, `you.tag`, `state`, and `conflict` (its `default` branch drops them) and works
exactly as before. An up-to-date client connected to an old Worker would receive NEITHER `fp` NOR
`tag`: it would adopt on every `hello` (`undefined !==` the last fingerprint) and create IDs without
a device label, so collisions would return. The reverse order is therefore a silent regression,
not a visible outage.

This remains true for the device label and op number:

- **old client + new Worker**: extra `tag`, `n`, and `kind` keys are ignored. Measured on the
  three-browser test bench (`duo3/x4`): 10/10, no JavaScript errors.
- **new client + old Worker**: the client falls back to comparison by email (the old behavior, so
  the second-device defect for one account remains), and a rejection without `n` triggers a full
  reread (`sync`) instead of a targeted rollback. Measured: both screens still converge on the
  server floor plan. Nothing breaks, but **per-device identity is fixed only after the Worker is deployed**.

This also remains true for acknowledgements and the counter rename:

- **old tab + new Worker**: three changes, all harmless. Extra `n` and `opCount` keys in the echo
  are ignored; `hello.acks` is ignored; and the two new message types (`ack`, `gap`) reach a `switch`
  **without a `default` branch** (verified in the deployed client: `wsOnMessage` has none), so they
  do nothing. The `rev` field disappears from the realtime wire: no deployed client reads it
  (verified by searching `src/js`), and an EARLIER tab that still read it would see
  `undefined !== its last value`, so it would adopt server state on every `hello`, the SAFE behavior
  we want. Proven by `tests/collab-accuses.ts`, case
  `les_messages_neufs_ne_derangent_pas_un_onglet_qui_les_ignore`.
- **new client + old Worker**: `hello` does not contain `acks`, so the client **does not enable any**
  resend mechanism (no queue, no guard delay, no acknowledged mirror that decides anything). It
  behaves exactly as it did before this batch. This is deliberate: without acknowledgements, an
  armed guard delay would resend the whole floor plan every 2,5 s into the void. Proven by
  `tests/collab-accuses.ts`, case `avant_une_op_perdue_n_est_rattrapee_par_rien`.

**Therefore: Worker first, client second.** In this order there is no regression window: the new
Worker serves old tabs without disrupting them, and the new client finds a Worker that already
knows how to acknowledge. In the reverse order, the new client would run with an old Worker in an
intentionally degraded mode (nothing breaks, but gap no. 2 remains open until the Worker arrives).

After deploying the Worker, reload both open tabs. Their in-memory op counter came from a DO that
no longer exists.
