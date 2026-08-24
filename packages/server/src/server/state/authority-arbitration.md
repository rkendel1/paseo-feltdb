# Phase 4.4: Durable Authority Arbitration

## Problem Statement

Multiple legitimate handoffs can target overlapping resources:
- Same task in same workspace (exclusive conflict)
- Same workspace in same project (overlapping authority)
- Same project (shared authority domain)

Current system allows this to become a race condition. Phase 4.4 makes authority arbitration **durable and deterministic**.

## Authority State Machine

Handoff lifecycle and authority implications:

```
pending
  ↓ [created but not yet accepted]
  ↓
accepted
  ↓ [agent claims authority]
  ↓
active authority ←─┐
  ↓                │ [performing delegated work]
  └────────────────┘
  ↓
completed / rejected / failed / revoked
  ↓ [authority released]
  ↓
terminal
```

## Conflict Scenarios

### Scenario 1: Exclusive Task Authority
```
H1 → Agent B, Task T1 (accepted, active)
H2 → Agent C, Task T1 (attempting acceptance)

Rule: Only ONE handoff can hold active exclusive authority over a task.
Result: H2 acceptance is REJECTED (H1 currently authoritative)
```

### Scenario 2: Overlapping Workspace Authority
```
H1 → Agent B, Workspace W1 (accepted, active)
H2 → Agent C, Workspace W1 (attempting acceptance)

Rule: Workspace authority can overlap (multiple agents working in same workspace)
       BUT exclusive task authority takes precedence within that workspace.
Result: H2 acceptance depends on task granularity:
  - If H2 also targets specific task: rejected (H1 owns that task)
  - If H2 is workspace-level: accepted (different scope level)
```

### Scenario 3: Competing Accepted Handoffs
```
H1 accepted by Agent B at T1
H2 accepted by Agent C at T1 (concurrent, no happens-before ordering)

Rule: Authority decision is durable, not based on memory.
      Atomically establish winner using FeltDB conditional write.
Result: Exactly one handoff remains active; other is revoked.
        Decision is persistent and survives restart.
```

### Scenario 4: Explicit Supersession
```
H1 active (Agent B, Task T1)
H2 created with supersedes: H1.id

Rule: Explicit supersession beats implicit arbitration.
Result: H1 is revoked (durable decision)
        H2 is accepted (durable decision)
        Agent B can no longer mutate T1
        Agent C can mutate T1
```

## Critical Invariant

**At any point in durable state, there is ONE deterministic answer to "who has authority?"**

Not memory state. Not last-write-wins. Not implicit precedence.

Reconstruction rule: Restart the system → read FeltDB → derive identical authority state.

## Arbitration Decision Model

Authority arbitration is itself a durable entity:

```typescript
interface AuthorityDecision {
  decisionId: string;           // unique decision identifier
  
  // What is being decided
  subjectType: "task" | "workspace" | "project";
  subjectId: string;             // task/workspace/project ID
  
  // The competing handoffs
  competingHandoffIds: string[]; // H1, H2, ...
  
  // The outcome
  winnerId: string;              // which handoff gets authority
  loserIds: string[];            // which handoffs are revoked
  
  // Reasoning
  arbitrationReason: 
    | "first_accepted"
    | "explicit_supersession"
    | "higher_priority"
    | "existing_authority";
  
  // Durability
  decidedAt: string;             // ISO timestamp
  decidedBy: "system" | "user";  // who made the decision
  
  // Version for concurrent updates
  version: number;               // optimistic concurrency control
}
```

## Deterministic Precedence Rules (Phase 4.4.1 Baseline)

For an exclusive task, when H2 attempts to accept while H1 is active:

```
rule: task_exclusive_authority
  condition: H1 accepted ∧ H2 attempting acceptance ∧ same task
  action: reject H2 acceptance, keep H1 active
  decision: "existing_authority" (H1 was there first)
```

For overlapping workspace-level authority:

```
rule: workspace_overlapping_authority
  condition: H1 active (workspace level) ∧ H2 attempting acceptance (workspace level)
  action: accept H2, both can work in workspace (not exclusive)
  decision: "accept_concurrent" (workspace authority is not exclusive)
```

For explicit supersession:

```
rule: explicit_supersession
  condition: H2.supersedes == H1.id ∧ H1 active
  action: revoke H1, accept H2
  decision: "explicit_supersession" (delegator explicitly transferred authority)
```

## Invariants to Verify

1. **Atomic Acceptance**: Only one handoff → active authority transition can succeed per (subject, task).
2. **No Silent Rejection**: If a handoff acceptance is rejected, the rejection is durable (persisted as AuthorityDecision).
3. **Single Authority**: At most one active handoff per exclusive task.
4. **Deterministic Recovery**: Restart → reconstruct identical authority state from FeltDB.
5. **Decision Immutability**: Once an AuthorityDecision is made, it's immutable (new supersession creates new decision, doesn't override old).

## Design Constraints

### Must Have for 4.4.1
- Authority conflict model (defined above)
- AuthorityDecision schema (FeltDB entity)
- Deterministic precedence rules for common conflicts
- Invariants documented

### Should Add in 4.4.2+
- Atomic acceptance logic (implement in handoff-service)
- Supersession/revocation logic
- Concurrent acceptance test suite
- Integration with AuthorityGuard

### Do NOT Add in 4.4.1
- Broad integration across subsystems (that's 4.4.3+)
- UI for authority conflicts
- Automatic priority inference
- Complex supersession policies

## Example: Atomic Acceptance Flow

This is the pattern 4.4.2+ will implement:

```
1. Agent C calls handoffService.accept(H2.id)
2. handoffService queries FeltDB: any active handoff on Task T1?
3a. No existing authority:
    → Create AuthorityDecision(winner: H2, reason: "first_accepted")
    → Set H2.status = accepted
    → Return success
3b. Existing H1 active:
    → Evaluate: supersession? explicit precedence? concurrent?
    → Create AuthorityDecision(winner: H1, loser: H2, reason: "existing_authority")
    → Reject H2 acceptance
    → Return rejection + decision
4. Decision is durable (survives restart)
5. On restart: reconstruct authority from AuthorityDecision + Handoff state
```

## Next Steps

Phase 4.4.1 Deliverables:
1. AuthorityDecision FeltDB schema
2. Arbitration model documentation (above)
3. Deterministic precedence rules
4. Invariant definitions
5. Design for atomic acceptance (pseudocode)

Phase 4.4.2 Deliverables:
1. Atomic acceptance implementation
2. Unit tests for single-task conflicts
3. Concurrent acceptance test suite
4. Restart recovery test
