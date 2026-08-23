/**
 * Resource Monitoring & Management
 *
 * Provides resource monitoring capabilities for Paseo to measure and track
 * memory footprint, CPU usage, and process lifecycle.
 *
 * Used for:
 * - Establishing baseline measurements
 * - Detecting memory leaks
 * - Enforcing resource budgets
 * - Benchmarking against alternative runtimes
 */

export { ResourceMonitor } from "./resource-monitor.js";
export type { ResourceSnapshot, ProcessMetrics, HeapMetrics, GCMetrics, ContainerMetrics, ResourceBudget } from "./resource-monitor.js";
