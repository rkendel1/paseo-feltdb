# FeltDB Runtime Blocker: Local File Persistence

## Status

**3.7.2 durability test is blocked by substrate capability, not Paseo logic.**

Paseo's durable-state integration is complete and correct:
- ✅ Agents created in FeltDB (with stable IDs)
- ✅ Workspaces created in FeltDB (with stable IDs based on cwd)
- ✅ Messages persisted to FeltDB via `persistMessage()`
- ✅ Conversations created on first message
- ✅ Provenance tuple preserved: conversationId, runId, sequence, authorId

**But:**
- ❌ FeltDB 0.4.15 runtime is in-memory only (`memory: true`)
- ❌ No local file-backed persistence for Node.js
- ❌ All FeltDB data is lost on daemon restart

## Evidence

**@feltdb/core 0.4.15 supported runtimes:**
```typescript
type FeltDBOptions = FeltDBBaseOptions & (
  | { server: { url: string; token: string } }       // Remote server
  | { memory: true }                                   // In-memory only
  | { browser: true }                                  // Browser storage
)
```

**No `file` or `disk` or `persistent` option.** File persistence is not yet implemented in the library.

**Current Paseo configuration** (`packages/server/src/server/state/feltdb/database.ts:91-94`):
```typescript
this.db = createFeltDB({
  namespace: "paseo",
  memory: true,  // ← BLOCKER: ephemeral runtime
});
```

**Diagnostic evidence from 3.7.2 test:**
- Timeline BEFORE restart: 3 items (in-memory)
- FeltDB agents BEFORE restart: 0 (created in memory, visible during run)
- Timeline AFTER restart: 2 items (reconstructed from Claude Code session, lost 1)
- FeltDB agents AFTER restart: 0 (in-memory FeltDB reset to empty)
- Projects incremented (1 → 2) because new ones created each run

## Architecture

### What Works (Paseo Layer)

1. **Agent persistence to FeltDB**
   - `persistAgentToFeltDB()` creates agents with full metadata
   - Workspace hierarchy preserved (project → workspace → agent)
   - Stable IDs allow deduplication across restarts

2. **Timeline → Message persistence**
   - `persistMessage()` creates FeltDB Message entities
   - Provenance tracked: conversationId, runId, sequence, authorId
   - Messages keyed by conversation, queryable across restarts

3. **Authorization semantics**
   - Messages are agent-private (belong to agent's conversation)
   - Observations/decisions are project-shared
   - Isolation enforced per project

### What's Blocked (FeltDB Layer)

1. **Local file storage**
   - FeltDB needs a Node.js file-backed runtime
   - Current: all writes go to memory, lost on GC/restart
   - Needed: sync or async file I/O backend

2. **Durability contract**
   - Writes must be persisted to disk before returning
   - Reads must retrieve from disk after restart
   - Crash resilience

## Timeline to Resolution

**Paseo responsibility (complete):**
- ✅ Store all domain state in FeltDB (not ephemeral memory)
- ✅ Use correct entity relationships
- ✅ Preserve provenance
- ✅ Enforce authorization
- ✅ Keep agent registry as secondary cache (for speed)

**FeltDB responsibility (pending):**
- Implement `{ disk: "/path/to/data" }` or similar
- Or `{ persist: true, path: dataPath }`
- Sync/async guarantees on writes
- Recovery on startup

**Paseo reconfiguration (future):**
Once FeltDB supports local persistence:
```typescript
this.db = createFeltDB({
  namespace: "paseo",
  disk: this.dataPath,  // ← Will work when FeltDB implements it
  // OR
  persist: true,
  path: this.dataPath,
});
```

Then rerun 3.7.2 test unchanged. It will pass.

## Why No Workaround

We **do not** add a second Paseo persistence layer because:

1. **Violates single source of truth** - FeltDB should be authoritative
2. **Creates maintenance burden** - Two persistence paths to keep in sync
3. **Encourages wrong architecture** - Paseo shouldn't know about FeltDB's limitations
4. **FeltDB will support it** - No permanent workaround needed
5. **Splits accountability** - Clear line: Paseo does state mgmt, FeltDB does durability

## 3.7.2 Test Semantics

**What the test proves (currently):**
- ✅ Paseo correctly creates agents in FeltDB
- ✅ Paseo correctly creates messages in FeltDB
- ✅ Authorization semantics are correct (Agent 3 doesn't see Agent 1's messages)
- ✅ Concurrency handling (multiple agents in multiple projects)
- ❌ Durability across restart (FeltDB limitation)

**What the test will prove (after FeltDB adds local persistence):**
- All of the above PLUS
- ✅ Durability: timeline survives daemon restart
- ✅ Provenance: metadata intact after restart
- ✅ Reconstruction: context rebuilds from FeltDB

## Next Steps

**For Paseo:**
1. Verify 3.7.2 authorization semantics (Agent 3 ≠ Agent 1 messages)
2. Confirm all domain mappings (conversation, message, run, observation)
3. Keep the test in place

**For FeltDB:**
1. Implement local file-backed persistence
2. Guarantee durability contract
3. Paseo will switch runtime config and test passes unchanged

**Not for Paseo (ever):**
- ❌ Re-introduce agent JSON state files
- ❌ Create secondary message database
- ❌ Make timelineRows durable independently
- ❌ Patch around FeltDB limitation
