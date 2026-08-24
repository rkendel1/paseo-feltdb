# FeltDB Integration Status Across Paseo Packages

## Executive Summary

FeltDB is **fully integrated as the authoritative substrate for the daemon** (server package), where all work state lives. The desktop, mobile, and CLI apps are **thin clients** that communicate with the daemon via WebSocket/gRPC and do not manage work state themselves.

**FeltDB Integration Status:**
- ✅ **Server (Daemon):** Full integration—FeltDB is authoritative
- ⚠️ **Desktop, Mobile, CLI:** Not applicable—clients don't persist work state
- ⚠️ **Context Injection:** Complete but not yet wired to agent providers (Phase 2 work)

---

## Architecture: Client-Server Boundary

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  Desktop    │    │   Mobile    │    │     CLI     │
│ (Electron)  │    │   (Expo)    │    │  (Commander)│
└──────┬──────┘    └──────┬──────┘    └──────┬──────┘
       │                  │                  │
       │   WebSocket      │   WebSocket      │   gRPC/WS
       │   (local-        │   (remote or     │   (direct)
       │    transport)    │    relay)        │
       └──────────────────┼──────────────────┘
                          │
                   ┌──────▼──────┐
                   │   Daemon    │
                   │  (Node.js)  │
                   └──────┬──────┘
                          │
                   ┌──────▼──────┐
                   │   FeltDB    │
                   │ (FileJsDb)  │
                   └─────────────┘
```

**Work state flows IN ONE DIRECTION:**
- Desktop/Mobile/CLI send actions (run agent, send message, create task)
- Daemon persists to FeltDB
- Clients receive updates via WebSocket stream (not polling FeltDB)

Clients **do not** have direct FeltDB access.

---

## Package-by-Package Status

### 1. `packages/server` (Daemon)

**FeltDB Integration:** ✅ **COMPLETE**

**What's Integrated:**

| Component | Status | Details |
|-----------|--------|---------|
| **PaseoState service** | ✅ Complete | Single access point for all durable state |
| **13 FeltDB collections** | ✅ Complete | Projects, repos, workspaces, agents, tasks, conversations, messages, runs, observations, decisions, handoffs, relationships, migrations |
| **File-based persistence** | ✅ Complete | FileJsDb (0.4.16) enabled, data survives daemon restart |
| **F1/F2/F3 primitives** | ✅ Complete | Atomic sequences, idempotent messaging, version control |
| **Authorization boundaries** | ✅ Complete | Agent-private conversations, project-shared observations |
| **Message persistence** | ✅ Complete | Provenance tracked (conversationId, runId, sequence, authorId) |
| **Context system (3.1)** | ✅ Complete | ContextResolver builds graph from FeltDB |
| **Context policy (3.2)** | ✅ Complete | ContextPolicyEngine intelligently filters context |

**What's Pending:**

| Component | Status | Details |
|-----------|--------|---------|
| **Context injection** | ⏳ In Progress | ContextResolver built, not yet wired to agent providers |
| **Observation extraction** | ⏳ Pending | Schema ready, auto-capture from agent timeline not implemented |
| **Decision extraction** | ⏳ Pending | Schema ready, auto-capture from agent events not implemented |
| **Handoff orchestration** | ⏳ Pending | Schema ready, `/paseo-handoff` skill not implemented |

**Daemon Architecture:**
```
bootstrap.ts
  ├─ HTTP/WebSocket server
  ├─ Daemon manager
  ├─ Session manager (per-client state)
  ├─ Agent manager (lifecycle, timeline)
  └─ PaseoState service (FeltDB)
       ├─ ResourceMonitor (resource tracking)
       └─ FeltDB collections (durable work state)
```

**Data Flow:**
```
Client action (WebSocket)
  ↓
Daemon receives message
  ↓
AgentManager / PaseoState updates FeltDB
  ↓
FeltDB persists to disk
  ↓
Daemon emits timeline event
  ↓
All subscribed clients receive update
```

### 2. `packages/desktop` (Electron)

**FeltDB Integration:** ❌ **NOT APPLICABLE** (client only)

**What Desktop Does:**
- Spawns and manages daemon subprocess
- Wraps Paseo web app in Electron
- Handles native features (file dialogs, notifications, window management)
- Communicates with daemon via local-transport (WebSocket)

**Desktop's Own Persistence:**
- Daemon logs (text file at `$PASEO_HOME/daemon.log`)
- Server ID (JSON at `$PASEO_HOME/.server-id`)
- **No work state stored locally**—all work state lives in FeltDB via daemon

**Key Files:**
- `daemon-manager.ts` — Spawn, stop, manage daemon process
- `local-transport.ts` — WebSocket communication with daemon
- `runtime-paths.ts` — Daemon executable path resolution

**Why Desktop Doesn't Use FeltDB Directly:**
1. Desktop is an Electron window, not a Node.js process with file access
2. All work state must be coordinated in daemon (multiple clients can connect)
3. Desktop is optional—headless daemon works without it
4. Keeping state in daemon ensures consistency across desktop, mobile, CLI clients

### 3. `packages/app` (Mobile + Web via Expo)

**FeltDB Integration:** ❌ **NOT APPLICABLE** (client only)

**What App Does:**
- React Native client (iOS, Android, web)
- Connects to daemon via WebSocket (direct or via relay)
- Manages local UI state (which tabs open, sidebar collapse, etc.)
- Never manages work state

**App's Own Persistence:**
- AsyncStorage for UI preferences (on mobile)
- localStorage for web client
- Does NOT store agents, tasks, conversations, or messages

**Why App Doesn't Use FeltDB:**
1. FeltDB is Node.js/Electron only (not available in React Native)
2. Work state must be server-side for multi-client coordination
3. Relay introduces E2E encryption—clients can't access server's filesystem
4. Mobile has no direct filesystem access to FeltDB

### 4. `packages/cli` (Commander)

**FeltDB Integration:** ❌ **NOT APPLICABLE** (client only)

**What CLI Does:**
- Docker-style commands: `paseo agent ls/run/stop`, `paseo daemon status`
- Communicates with daemon via WebSocket (gRPC-compatible)
- Scripting interface to the same daemon that desktop and mobile use

**CLI's Own Persistence:**
- Config file at `~/.paseo/config.json` (for daemon URLs, not work state)
- None for agents, tasks, conversations, messages

**Why CLI Doesn't Use FeltDB:**
1. CLI is a thin wrapper around daemon-client
2. Multiple daemons can run (local, remote) —state lives in daemon, not CLI
3. Work state is queried from daemon on each command, not cached

---

## Data Isolation: How Clients See Work State

**When desktop/mobile/CLI asks "what agents exist?"**

```
Client API call (via daemon-client)
  ↓
Daemon receives message
  ↓
Daemon queries FeltDB:
  agents.find({ workspaceId: "..." })
  ↓
FeltDB returns records from disk
  ↓
Daemon streams results via WebSocket
  ↓
Client receives and displays
```

**Desktop does NOT:**
- Have local copy of agents
- Cache agents in memory between restarts
- Re-run queries when restarted

**Result:**
- Restart desktop → daemon reconnects to FeltDB → agents appear
- Restart daemon → FeltDB persists, agents still exist
- Daemon crash → agents survive (in FeltDB) until daemon restarts

---

## FeltDB Readiness Per Package

| Package | FeltDB Ready | Notes |
|---------|--------------|-------|
| **server** | ✅ YES | Fully integrated, production-ready |
| **desktop** | ✅ YES (via daemon) | Talks to FeltDB through daemon |
| **app** | ✅ YES (via daemon) | Talks to FeltDB through daemon |
| **cli** | ✅ YES (via daemon) | Talks to FeltDB through daemon |

**Meaning:** All packages can use FeltDB. Clients don't need direct access—they use daemon.

---

## Remaining Work to Make Agents Fully Use FeltDB

The substrate (FeltDB) is ready. The client-server integration is ready. What's **NOT** ready is **using** the substrate to make agents smarter.

### Phase 2: Wire Context to Agents

**Current state:**
- ContextResolver builds complete graph from FeltDB ✅
- ContextPolicyEngine filters intelligently ✅
- **But:** Context is not injected into agent prompts ❌

**What needs to happen:**
```
Agent starts
  ↓
ContextResolver.resolve(agentId) → AgentContext
  ↓
ContextPolicyEngine.apply(context, request) → bounded context
  ↓
Pass bounded context to Claude Agent SDK (currently: NOT DONE)
  ↓
Agent uses prior observations + decisions + conversations
  ↓
Agent makes better decisions (learns from project history)
```

**Status:** ContextResolver and ContextPolicyEngine are built and tested. The last 2 steps (pass to SDK, verify agents use it) are pending.

### Phase 2: Observation & Decision Recording

**Current state:**
- Observation schema exists (observations table)
- Decision schema exists (decisions table)
- **But:** Nothing automatically captures observations from agent output ❌

**What needs to happen:**
```
Agent completes task
  ↓
Timeline has events (files changed, bugs found, dependencies added, etc.)
  ↓
Observation extractor tags them (implementation_detail, bug_found, etc.)
  ↓
Creates Observation records in FeltDB
  ↓
Next agent sees these observations in context
```

**Status:** Schema ready, extractor not implemented.

### Phase 3: Agent Orchestration

**Current state:**
- Handoff schema exists (handoffs table)
- **But:** No skill to delegate between agents ❌

**What needs to happen:**
```
Agent A wants to delegate to Agent B
  ↓
/paseo-handoff skill triggers
  ↓
Creates Handoff record in FeltDB
  ↓
Starts Agent B with Agent A's context
  ↓
Agent B continues work, sees Agent A's decisions
```

**Status:** Schema ready, skill not implemented.

---

## Summary: Is Desktop Running on FeltDB?

**Direct answer:** No—and it doesn't need to.

**Better answer:** Desktop is a client for FeltDB-backed daemon. When you run Paseo desktop:

1. Desktop spawns daemon as subprocess
2. Daemon connects to FeltDB (file-based persistence at `$PASEO_HOME/feltdb/`)
3. Desktop talks to daemon via WebSocket
4. All work state flows through FeltDB

**So effectively:** Yes, everything desktop does is persisted in FeltDB, but indirectly through the daemon.

**Can desktop work without FeltDB?** No—if you remove FeltDB or break the daemon's persistence, agents won't survive restart.

**Can desktop work without connecting to daemon?** No—desktop is purely a UI wrapper that requires the daemon.

---

## What "Fully Integrated" Means

| Criteria | Status | Details |
|----------|--------|---------|
| **Substrate ready** | ✅ YES | FeltDB file-based persistence working |
| **Schema complete** | ✅ YES | 13 collections with proper relationships |
| **Data survives restart** | ✅ YES | Agents, messages, decisions persist |
| **Client-server clear** | ✅ YES | Clients never touch FeltDB directly |
| **Agents use history** | ❌ NO | Context resolver built but not wired to providers |
| **Context injected** | ❌ NO | Phase 2 work |
| **Observations auto-recorded** | ❌ NO | Phase 2 work |
| **Handoff orchestration** | ❌ NO | Phase 3 work |

**Bottom line:** The foundation is solid. What's left is teaching agents to USE the history we're now recording.
