# PR: Investigate and Reduce Paseo macOS Memory Footprint

## Objective

Investigate reports that Paseo consumes excessive memory on macOS and reduce its idle and active resource footprint without weakening isolation, durability, or agent execution capabilities.

**The investigation must establish where memory is actually being consumed before making runtime changes.**

As part of the investigation, evaluate Apple's native container runtime as a macOS execution backend and determine whether it provides a materially better resource profile than the current Docker-based runtime.

---

## Problem

Paseo currently uses containerized infrastructure on macOS. There are reports of high memory consumption, but the current architecture does not establish whether the dominant cost comes from:

- Docker's Linux VM
- Container resource allocation
- Paseo services
- Node.js processes
- FeltDB
- Agent/provider processes
- Build tooling
- Filesystem/index/cache behavior
- Duplicated runtimes
- Leaked/orphaned processes
- Long-lived idle services
- Concurrent agent execution

**We should not optimize based on assumption.**

The first deliverable is a measurable memory/resource baseline.

---

## Goals

### 1. Establish a Reproducible macOS Resource Baseline

Measure Paseo under standardized workloads:

- Cold startup
- Idle after startup
- One active agent
- Multiple concurrent agents
- Sustained agent execution
- Large conversation/context
- Large FeltDB state
- Repeated task execution
- Daemon restart
- Container restart
- Shutdown/cleanup

**Capture at minimum:**

- Resident memory (RSS)
- Peak memory
- CPU
- Process count
- Container/VM memory
- Disk growth
- Network activity
- Startup time
- Task execution latency

**The measurements must distinguish:**

```
Paseo host processes
        +
Docker/Container runtime
        +
Paseo containers
        +
Agent processes
        +
FeltDB
```

Rather than reporting only total system memory.

### 2. Identify the Dominant Memory Consumers

Produce a memory attribution report. For every major process/service, record:

- PID/process name
- RSS
- Virtual memory
- CPU
- Lifetime
- Parent process
- Command line
- Container/VM association

**Classify memory into:**

- Paseo application
- FeltDB
- Node/runtime
- Agent process
- Container runtime
- Linux VM
- Caches
- Build tooling
- Unknown

**Any optimization should be tied to an identified source of memory pressure.**

### 3. Audit Paseo Lifecycle Behavior

Specifically investigate whether Paseo leaves behind:

- Orphaned agents
- Orphaned child processes
- Stale containers
- Unused container services
- Duplicate daemons
- Persistent build processes
- Watchers
- Subprocess pipes
- Retained execution state
- Excessive in-memory context
- Unbounded timeline/event buffers
- Unbounded agent output
- Duplicate context representations

**Agent execution must have an explicit lifecycle:**

```
create
  ↓
execute
  ↓
collect evidence
  ↓
persist required state
  ↓
release resources
```

**Persisted state should live in FeltDB rather than remaining unnecessarily resident in process memory.**

### 4. Context/Memory Audit

Because Paseo now has a durable ContextResolver and ContextPolicyEngine, verify that context injection does not create large in-memory graphs or duplicate large portions of the work graph.

**Measure:**

- Context graph size
- Serialized context size
- Provider prompt size
- Number of FeltDB records loaded
- Number of observations loaded
- Number of decisions loaded
- Number of conversations loaded
- Peak memory during resolution
- Peak memory during provider invocation

**The desired architecture is:**

```
FeltDB
  ↓
ContextResolver
  ↓
ContextPolicyEngine
  ↓
bounded ContextEnvelope
  ↓
Agent Provider
```

**Not:**

```
FeltDB
  ↓
load entire project graph
  ↓
retain graph in memory
  ↓
filter later
  ↓
provider
```

**Context must be bounded before provider execution.**

### 5. Evaluate Apple Containers on macOS

Evaluate Apple's native container runtime as an alternative to Docker Desktop for Paseo's macOS execution environment.

Apple's container runtime uses lightweight Linux VMs through Apple's virtualization stack and is optimized for Apple silicon. It consumes standard OCI images, allowing the existing container packaging model to remain largely compatible.

**The evaluation must cover:**

#### Compatibility

Verify that Paseo's current container workload can run under:

- OCI images
- Environment variables
- Networking
- Port exposure
- Volume persistence
- Filesystem mounts
- Process execution
- Health checks
- Persistent FeltDB data
- Service-to-service communication

#### Resource Behavior

Compare Docker vs Apple Containers for:

- Baseline memory
- Idle memory
- Active memory
- Peak memory
- CPU
- Startup time
- Shutdown time
- Disk usage
- Filesystem performance
- Network performance

**Use the same Paseo workload and same resource limits.**

Apple's runtime exposes explicit CPU and memory limits, with documented defaults of 4 CPUs and 1 GiB RAM for containers.

### 6. Evaluate Container Machine

Do not limit the investigation to individual containers.

Evaluate Apple's newer container machine capability as a possible better fit for Paseo's long-lived local development/runtime boundary.

Apple describes container machines as persistent Linux environments intended to provide a lightweight, integrated Linux environment on macOS.

**Compare:**

- Docker Desktop
- Apple container
- Apple container machine

**against Paseo's actual requirements.**

The goal is not to adopt Apple technology merely because it is Apple-native. The goal is to determine which runtime provides the best:

- Memory footprint
- Startup experience
- Persistence
- Isolation
- Filesystem behavior
- Networking
- Developer experience
- Operational simplicity

### 7. Introduce a Runtime Abstraction

If Apple Containers proves beneficial, Paseo should not hard-code the runtime.

Introduce a runtime abstraction:

```typescript
ContainerRuntime
├── DockerRuntime
└── AppleContainerRuntime
```

**Potential interface:**

```typescript
create()
start()
stop()
restart()
remove()
exec()
logs()
stats()
health()
mount()
network()
```

**The Paseo execution layer should depend on the abstraction rather than Docker-specific commands.**

**Runtime selection should be explicit:**

```
PASEO_RUNTIME=docker
PASEO_RUNTIME=apple-container
```

With automatic macOS selection only after the Apple runtime has passed compatibility and resource validation.

### 8. Resource Policy

Define explicit Paseo resource budgets.

At minimum:

```
Paseo host:
  baseline memory target
  active execution target
  maximum expected memory

Agent:
  memory limit
  CPU limit
  process limit

Container:
  memory limit
  CPU limit

Build:
  memory limit
  CPU limit
```

**Avoid relying on unlimited host resources.**

**Resource limits should be configurable based on host capacity.**

### 9. Acceptance Criteria

#### Memory

Establish a reproducible baseline before optimization.

After optimization:

- Idle memory is reduced materially from baseline
- Peak memory is reduced or clearly bounded
- No unexplained memory growth occurs during repeated executions
- No significant memory leak is observed during sustained operation
- Completed agent executions release their process/runtime resources

#### Lifecycle

Repeated:

```
start → execute → finish → cleanup
```

must not produce monotonic process or memory growth.

#### Persistence

Resource optimization must not compromise:

- FeltDB durability
- Restart recovery
- Agent history
- Observations
- Decisions
- Handoffs
- Context reconstruction

#### Runtime Compatibility

If Apple Containers is adopted:

- Existing OCI images remain usable
- FeltDB persistent storage remains durable
- Networking works
- Health checks work
- Agent execution works
- Restart/recovery works

#### Regression Protection

Add automated resource/lifecycle tests where practical.

At minimum, add a soak scenario that repeatedly executes agents and verifies that memory/process counts remain bounded.

---

## Implementation Order

### Phase 1 — Measurement

1. Add Paseo resource diagnostics (`ResourceMonitor` class)
2. Establish macOS baseline
3. Capture process/container/VM attribution
4. Run standardized workloads
5. Produce memory profile

**Files created:**

- `packages/server/src/server/resource/resource-monitor.ts` — ResourceMonitor class
- `packages/server/src/server/resource/resource-lifecycle.test.ts` — Lifecycle tests

### Phase 2 — Paseo Optimization

6. Fix identified lifecycle leaks
7. Bound context materialization
8. Bound agent output retention
9. Release completed execution resources
10. Add resource limits configuration

### Phase 3 — Apple Container Evaluation

11. Implement experimental Apple Container runtime
12. Run the same benchmark suite
13. Compare Docker vs Apple Containers
14. Evaluate container machine for persistent local runtime use

**Files created:**

- `packages/server/src/server/runtime/container-runtime.ts` — Abstraction
- `packages/server/src/server/runtime/docker-runtime.ts` — Docker implementation
- `packages/server/src/server/runtime/apple-container-runtime.ts` — Placeholder

### Phase 4 — Adoption Decision

15. If Apple Containers materially improves the resource profile, make it the preferred macOS runtime
16. Retain Docker for environments where Apple Containers is unavailable
17. Document runtime selection and requirements
18. Add CI coverage for both supported runtime paths

---

## Deliverables

This PR should produce:

- ✅ macOS resource baseline (Phase 1)
- ✅ Memory attribution report (Phase 1)
- ⏳ Lifecycle/leak findings (Phase 2)
- ⏳ Resource-budget configuration (Phase 2)
- ⏳ Bounded context-memory behavior (Phase 2)
- ✅ Runtime abstraction (Phase 3)
- ⏳ Experimental Apple Container backend (Phase 3)
- ⏳ Docker vs Apple Container benchmark (Phase 3)
- ⏳ Adoption recommendation (Phase 4)
- ⏳ Regression/soak tests (Phase 4)

---

## Non-goals

This PR does not:

- Replace FeltDB
- Redesign Paseo's persistence model
- Change the ContextResolver architecture
- Introduce a new agent framework
- Optimize agent model inference itself
- Remove Docker support without benchmark evidence

---

## Success Definition

**Paseo should feel like a native, bounded local application on macOS rather than a collection of heavyweight services.**

The final architecture should make the execution environment explicit:

```
                    Paseo
                      │
             ┌────────┴────────┐
             │                 │
        Work Graph        Agent Runtime
             │                 │
           FeltDB        ContainerRuntime
                               │
                 ┌─────────────┴─────────────┐
                 │                           │
              macOS                       Linux
                 │                           │
        Apple Container                  Docker
        / Container Machine
```

---

## Key Principle

**Measure first, optimize Paseo second, evaluate Apple Containers third, and adopt it only if the measurements justify it.**

No assumptions. Data-driven.
