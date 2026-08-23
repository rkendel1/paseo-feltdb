/**
 * Container Runtime Abstraction
 *
 * This module provides an abstract interface for container execution runtimes,
 * allowing Paseo to support multiple backends (Docker, Apple Containers, etc.)
 * without hard-coding implementation details.
 *
 * This abstraction is used to evaluate and compare different runtime options
 * based on measurable performance characteristics (memory, startup time, etc.)
 * rather than assumptions.
 */

export type { IContainerRuntime, ContainerConfig, ContainerStats, ExecutionResult, RuntimeConfig } from "./container-runtime.js";
export { createContainerRuntime, getRuntimeName } from "./container-runtime.js";
export { DockerRuntime } from "./docker-runtime.js";
export { AppleContainerRuntime } from "./apple-container-runtime.js";
