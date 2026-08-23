# Architecture Fix: Timeline → FeltDB Durability

## Problem
Timeline items exist in two places with different lifetimes:
- **Ephemeral**: `agent.timelineRows` (in-memory, lost on restart)
- **Durable**: FeltDB (empty, never written to)

This violates the promised architecture: FeltDB is the durable source of truth.

## Solution
Make timeline items create durable FeltDB entities at the point of creation.

### Change 1: Timeline Messages → FeltDB Messages

**Location**: `packages/server/src/server/agent/agent-manager.ts`

**Method**: `recordTimeline()`

**Current behavior**:
```typescript
private recordTimeline(agent: ManagedAgent, item: AgentTimelineItem): AgentTimelineRow {
  const timelineState = this.ensureTimelineState(agent);
  const row: AgentTimelineRow = { seq, timestamp, item };
  agent.timeline.push(item);           // In-memory only
  timelineState.rows.push(row);        // In-memory only
  // NO FeltDB call
  return row;
}
```

**Target behavior**:
```typescript
private async recordTimeline(
  agent: ManagedAgent, 
  item: AgentTimelineItem,
  context?: { runId?: string }
): AgentTimelineRow {
  const timelineState = this.ensureTimelineState(agent);
  const row: AgentTimelineRow = { seq, timestamp, item };
  agent.timeline.push(item);
  timelineState.rows.push(row);
  
  // NEW: Create durable FeltDB entities
  if (item.type === "user_message") {
    await this.createMessageInFeltDB(agent, item, context?.runId, row.seq);
  } else if (item.type === "assistant_message") {
    await this.createMessageInFeltDB(agent, item, context?.runId, row.seq);
  }
  
  return row;
}
```

**Requires**:
1. Access to `paseoState` (already available in agent-manager)
2. Get/create Conversation for agent (if not exists)
3. Get current Run context (passed from caller if available)
4. Increment message sequence within conversation

### Change 2: Propagate Context Through Call Chain

**Methods that call recordTimeline**:
- `appendUserMessage()` at line 1014 - has access to agent context
- `appendTimelineItem()` at line 1039 - generic append
- `handleStreamEvent()` at line 2393 - execution event (has runId from event context)

**Action**: Pass run context through to recordTimeline so messages have runId.

### Change 3: Convert fetchAgentTimeline to FeltDB Query

**Location**: Same handler but refactor to query FeltDB

**Current**: Returns `agent.timelineRows` directly from in-memory state

**Target**: Query FeltDB Messages by conversation, reconstruct timeline projection

This is a larger change and can follow after message persistence is proven.

## Testing Strategy

1. **Run 3.7.2 unchanged** - it will fail on same assertions (by design)
2. **Verify FeltDB now has Messages** - diagnostic should show Messages exist
3. **Verify timeline reconstruction** - 3 items persist, 3 items reconstructed
4. **Verify authorization contract**:
   - Agent 1: sees own messages ✓
   - Agent 3: does NOT see Agent 1's messages ✓ (agent-private)
   - Agent 3: WILL see Agent 1's observations ✓ (project-shared, once created)
   - Agent 2: sees nothing from Project A ✓ (different project)

## Provenance Validation

Each Message will contain:
- `conversationId` — which conversation it belongs to
- `runId` — which agent run created it
- `sequence` — immutable position in conversation
- `authorId` — which agent or user created it
- `authorType` — "user", "agent", "system", "tool"

This is the complete provenance tuple that survives restart.

## Risk Mitigation

- Preserve `agent.timelineRows` as in-memory cache (for now)
- All writes go to FeltDB
- If FeltDB write fails, log but don't block agent execution
- Reconstruct timeline from FeltDB if cache is empty/incomplete

## Success Criteria

✓ 3.7.2 test runs without changes  
✓ FeltDB messages exist after agent execution  
✓ After daemon restart, same messages reconstructed from FeltDB  
✓ Message count 3 → 3 (not 3 → 2)  
✓ Provenance intact (conversationId, runId, sequence, authorId)  
✓ Authorization contract validated (private vs shared)  
