# Paseo Authorization & Visibility Contract

**Version**: 1.0  
**Status**: Normative (authoritative for all authorization checks)  
**Date**: 2026-08-23

This document defines the explicit authorization and visibility boundaries for the FeltDB-backed agent architecture. It is the single source of truth for what data each actor can access and modify.

---

## Entity Visibility & Authority Matrix

| Entity | Scope | Read Visibility | Mutation Authority |
|--------|-------|-----------------|-------------------|
| **Project** | Project | Project participants | Authorized project operations only |
| **Repository** | Project | Project participants | Project-authorized operations only |
| **Workspace** | Project | Project participants with workspace access | Workspace/project-authorized operations |
| **Agent** | Agent-private | Owning agent / authorized runtime | Owning runtime only |
| **Conversation** | Agent-private | Owning agent only | Owning agent only |
| **Message** | Conversation-private | Conversation owner only | Conversation owner only |
| **Run** | Agent/project provenance | Owning agent + authorized project scope | Creating agent/runtime only |
| **Observation** | Project-scoped | Project participants | Authorized project agent/runtime |
| **Decision** | Project-scoped | Project participants | Authorized project agent; approval by authorized human |
| **Task** | Project-scoped | Project participants | Authorized project agent/runtime |

---

## Fundamental Distinction: Agent-Private vs Project-Shared

### Agent-Private Knowledge

```
Agent
  └── Workspace (agent's working context)
       └── Conversation
            └── Messages (private to agent)
```

**Characteristics**:
- Only the owning agent can read or write
- Not visible to other agents in same project
- Not included in multi-agent context sharing
- Represents agent's internal reasoning state

**Entities**:
- Agent (self-reference only)
- Conversation (agent-private by definition)
- Message (within conversation, only conversation owner)

**Enforcement Rule**: Agent-private entities must validate `agentId` ownership at write time.

### Project-Shared Knowledge

```
Project
  ├── Repository (team codebase context)
  ├── Workspace (team work context)
  ├── Tasks (collaborative work)
  ├── Observations (verified facts)
  └── Decisions (team decisions)
```

**Characteristics**:
- All project participants can read
- Can be written by authorized agents
- Visible to other agents in same project
- Represents shared team knowledge

**Entities**:
- Repository (project's code)
- Workspace (team workspaces)
- Task (team tasks)
- Observation (verified runtime facts)
- Decision (team decision record)

**Enforcement Rule**: Project-shared entities must validate `projectId` ownership at write time.

### Execution Provenance: Run

```
Agent → Run
         ├── Observations (captured during run, project-scoped)
         ├── Decisions (made during run, project-scoped)
         ├── Messages (sent by agent, agent-private)
         └── Project/Agent scope (hybrid)
```

**Characteristics**:
- Created by specific agent (owning agent visibility)
- Scoped to project (authorization context)
- Can reference both agent-private and project-shared entities
- Run creation **must validate** agent's workspace.projectId matches run.projectId

**Enforcement Rule**: Runs bind agent to project; verify `workspace.projectId === run.projectId` at creation.

---

## Critical Separation: Authorization vs Context Policy

These are **not the same**:

```
Authorization Layer
    ↓
Can this agent access the entity?
(Read authorization check: does agent have right to see this?)
    ↓
Context Policy Layer
    ↓
Is this entity relevant to this request?
(Relevance check: should this go in the prompt?)
    ↓
Context Budget
    ↓
Does it fit in the token budget?
    ↓
Provider
```

**Example**:
- Agent can be **authorized** to read a Decision (project participant)
- But the Decision might not be **relevant** to current prompt (archived, unrelated)
- Context policy says "don't include archived decisions"
- Authorization says "agent can access archived decisions if needed"

**Rule**: If authorization fails, the entity is not accessible. If authorization passes but context policy filters it, that's correct selectivity.

---

## Enforcement Points

Authorization checks must occur at the **domain layer** (PaseoState), not in providers or context resolver:

```
Agent Request
    ↓
PaseoState Layer (ENFORCEMENT POINT)
    - Validate agentId for agent-private entities
    - Validate projectId for project-shared entities
    - Validate workspace.projectId for run creation
    ↓
FeltDB (should only receive pre-authorized requests)
    ↓
Context Resolver (assumes pre-authorization passed)
    ↓
Context Policy (applies relevance filtering)
    ↓
Provider
```

**Why domain layer**: Authorization rules cannot be bypassed through normal Paseo APIs. Any path to data goes through PaseoState checks.

**What domain layer does**:
- Validates ownership/project-scoping at creation
- Validates ownership/project-scoping at mutation
- Validates agent's workspace project on operations
- Raises explicit authorization errors with human-readable messages

**What domain layer does NOT do**:
- Filter at read time (context policy does that)
- Make relevance decisions (context policy does that)
- Budget context (context policy does that)

---

## Specific Authorization Rules

### Agent-Private Entities: Write Authorization

**Conversation.create()**:
- No explicit check needed at creation (conversation is created with agentId)
- `conversation.agentId` must equal `requestingAgent.id`

**Message.create()**:
- **ENFORCED**: Verify `conversation.agentId === requestingAgent.id`
- Error: "Authorization denied: Agent cannot write to other agent's conversation"
- Implementation: Add check in repositories.ts messages.create()

**Conversation.delete() / Message.delete()**:
- **ENFORCED**: Same check as write
- Error: "Authorization denied: Agent cannot delete other agent's conversation"

### Project-Shared Entities: Write Authorization

**Observation.create/update/delete()**:
- **ENFORCED**: Verify agent's workspace belongs to observation's project
- Check: `agent.workspace.projectId === observation.projectId`
- Error: "Authorization denied: Agent cannot modify observations in other projects"
- Implementation: Add check in observation-persistence.ts

**Task.update() / Decision.update()**:
- **ALREADY ENFORCED** ✓ (explicit checks present)
- Same pattern: workspace.projectId validation

### Execution Provenance: Write Authorization

**Run.create()**:
- **ENFORCED**: Verify agent's workspace project matches run project
- Check: `agent.workspace.projectId === run.projectId`
- Error: "Authorization denied: Agent cannot create runs in other projects"
- Implementation: Add check in run-manager.ts createRun()

**Run.update()**:
- **ENFORCED**: Same check as create
- Cannot move run to different project after creation

### Read Visibility

**listByAgent(agentId)**:
- Returns only entities owned by agentId
- Implementation: FeltDB filter (no additional check needed)
- Entities: Conversation, Message (via conversation), Run (via agent)

**listByProject(projectId)**:
- Returns only entities in projectId
- Implementation: FeltDB filter (no additional check needed)
- Entities: Task, Observation, Decision, Repository, Workspace

**getById(id)**:
- **NOTE**: Returns entity regardless of caller
- Context resolver/policy responsible for filtering results
- Authorization check happens at **use** time (inclusion in context), not at **read** time
- This preserves separation: data access vs prompt inclusion

---

## Boundary Violations & How to Catch Them

### Detection: Tests Must Cover Each Rule

Each authorization rule in this contract should have a test that:

1. Attempts the operation without authorization
2. Verifies it fails with explicit error message
3. Attempts with authorization
4. Verifies it succeeds

Example (SCENARIO-4 test):
```typescript
// Agent A tries to write to Conversation B (owned by Agent B)
const error = await messages.create({
  conversationId: conversationB.id,
  content: "Unauthorized",
  authorAgentId: agentA.id, // FAIL: different agent
});
expect(error.message).toMatch(/Authorization denied/);

// Agent B writes to own conversation
const msg = await messages.create({
  conversationId: conversationB.id,
  content: "Authorized",
  authorAgentId: agentB.id, // PASS: owns conversation
});
expect(msg).toBeDefined();
```

### Guard: Code Review Checklist

For any PR modifying PaseoState or persistence layers:
- [ ] Does this change entity read/write paths?
- [ ] If yes, does it add/modify authorization checks?
- [ ] Are checks domain-level (PaseoState), not in caller?
- [ ] Do checks reference this contract?
- [ ] Are there tests for both allow and deny cases?
- [ ] Is error message explicit ("Authorization denied: reason")?

---

## Terminology

- **Authorization**: Can agent X access entity Y? (yes/no decision, binary)
- **Visibility**: Which entities can agent X see? (set of accessible entities)
- **Read Authorization**: Can agent X retrieve entity Y?
- **Write Authorization**: Can agent X create/update/delete entity Y?
- **Mutation**: Any create, update, or delete operation
- **Scope**: The boundary around which entities are related (agent-private, project-scoped)
- **Domain Layer**: PaseoState and persistence classes where authorization is enforced
- **Context Policy**: Selection logic that determines what should go in a prompt (separate from authorization)

---

## Status: Normative

This contract is **normative**, meaning:
- All authorization checks must comply with this contract
- Future changes to entity models must be reviewed against this contract
- Code review must verify compliance
- Tests must validate boundaries defined here

This is not a description of current state. It is the **target state**. Gaps (currently identified gaps in SCENARIO-3, SCENARIO-4, SCENARIO-6) must be closed to comply.

---

## See Also

- [AUTHORIZATION_AUDIT_FINDINGS.md](./AUTHORIZATION_AUDIT_FINDINGS.md) — Evidence of current gaps
- [authorization-isolation.test.ts](./authorization-isolation.test.ts) — Executable test suite verifying this contract
