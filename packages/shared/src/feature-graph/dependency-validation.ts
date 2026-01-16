import { FeatureGraph } from "./graph.js";
import { FeatureNode } from "./types.js";

/**
 * Result of dependency validation for a feature.
 */
export interface DependencyValidationResult {
  /** The feature being validated */
  featureId: string;
  /** Whether all dependencies are satisfied (completed) */
  canProceed: boolean;
  /** Dependencies that are not yet completed */
  blockedBy: FeatureNode[];
  /** Dependencies that are completed */
  satisfiedDependencies: FeatureNode[];
  /** Suggested order to develop blocked dependencies */
  suggestedOrder: FeatureNode[];
}

/**
 * Result of checking what features are unblocked after a feature completes.
 */
export interface UnblockedFeaturesResult {
  /** The feature that was just completed */
  completedFeatureId: string;
  /** Features that are now unblocked and ready for development */
  nowUnblocked: FeatureNode[];
  /** Features that are still blocked by other dependencies */
  stillBlocked: Array<{
    feature: FeatureNode;
    remainingBlockers: FeatureNode[];
  }>;
}

/**
 * Check if a feature's development progress indicates it's completed.
 */
export function isFeatureCompleted(feature: FeatureNode): boolean {
  return feature.development_progress === "Completed";
}

/**
 * Check if a feature is ready to be developed (has no incomplete dependencies).
 */
export function isFeatureReadyForDevelopment(feature: FeatureNode): boolean {
  // A feature is ready if it's not already completed and not in progress
  return (
    feature.development_progress !== "Completed" &&
    feature.development_progress !== "In Progress"
  );
}

/**
 * Get all upstream dependencies for a feature (recursive).
 * Returns dependencies in topological order (deepest dependencies first).
 */
export function getAllUpstreamDependencies(
  graph: FeatureGraph,
  featureId: string,
  visited: Set<string> = new Set()
): FeatureNode[] {
  if (visited.has(featureId)) {
    return [];
  }
  visited.add(featureId);

  const dependencies: FeatureNode[] = [];
  const directUpstream = graph.getNeighbors(featureId, "upstream");

  for (const upstream of directUpstream) {
    // Recursively get dependencies of this dependency
    const transitiveDeps = getAllUpstreamDependencies(graph, upstream.id, visited);
    dependencies.push(...transitiveDeps);
    // Add the direct dependency after its dependencies (topological order)
    dependencies.push(upstream);
  }

  return dependencies;
}

/**
 * Validate whether a feature can be developed based on its dependencies.
 * Returns information about what's blocking it and suggested development order.
 */
export function validateFeatureDependencies(
  graph: FeatureGraph,
  featureId: string
): DependencyValidationResult {
  const feature = graph.getFeature(featureId);
  if (!feature) {
    return {
      featureId,
      canProceed: false,
      blockedBy: [],
      satisfiedDependencies: [],
      suggestedOrder: [],
    };
  }

  // Get all upstream dependencies (recursive)
  const allDependencies = getAllUpstreamDependencies(graph, featureId);

  const blockedBy: FeatureNode[] = [];
  const satisfiedDependencies: FeatureNode[] = [];

  for (const dep of allDependencies) {
    if (isFeatureCompleted(dep)) {
      satisfiedDependencies.push(dep);
    } else {
      blockedBy.push(dep);
    }
  }

  // Suggested order: dependencies that aren't completed, in topological order
  // Filter to only include features that are themselves unblocked
  const suggestedOrder = blockedBy.filter((dep) => {
    const depUpstream = graph.getNeighbors(dep.id, "upstream");
    return depUpstream.every((upstream) => isFeatureCompleted(upstream));
  });

  return {
    featureId,
    canProceed: blockedBy.length === 0,
    blockedBy,
    satisfiedDependencies,
    suggestedOrder,
  };
}

/**
 * Validate multiple features and return which ones can proceed.
 */
export function validateMultipleFeatures(
  graph: FeatureGraph,
  featureIds: string[]
): Map<string, DependencyValidationResult> {
  const results = new Map<string, DependencyValidationResult>();

  for (const featureId of featureIds) {
    results.set(featureId, validateFeatureDependencies(graph, featureId));
  }

  return results;
}

/**
 * Get features that should be developed first based on dependency order.
 * Returns features in topological order (no dependencies first).
 */
export function getTopologicalFeatureOrder(
  graph: FeatureGraph,
  featureIds: string[]
): FeatureNode[] {
  const featureSet = new Set(featureIds);
  const ordered: FeatureNode[] = [];
  const visited = new Set<string>();

  function visit(featureId: string) {
    if (visited.has(featureId) || !featureSet.has(featureId)) {
      return;
    }

    const feature = graph.getFeature(featureId);
    if (!feature) return;

    // Visit all upstream dependencies first
    const upstream = graph.getNeighbors(featureId, "upstream");
    for (const dep of upstream) {
      if (featureSet.has(dep.id)) {
        visit(dep.id);
      }
    }

    visited.add(featureId);
    ordered.push(feature);
  }

  for (const featureId of featureIds) {
    visit(featureId);
  }

  return ordered;
}

/**
 * After a feature is completed, find what downstream features are now unblocked.
 */
export function getUnblockedFeatures(
  graph: FeatureGraph,
  completedFeatureId: string
): UnblockedFeaturesResult {
  const nowUnblocked: FeatureNode[] = [];
  const stillBlocked: Array<{
    feature: FeatureNode;
    remainingBlockers: FeatureNode[];
  }> = [];

  // Get all downstream features that depend on this one
  const downstream = graph.getNeighbors(completedFeatureId, "downstream");

  for (const feature of downstream) {
    // Skip if already completed or in progress
    if (feature.development_progress === "Completed") {
      continue;
    }

    // Check if all upstream dependencies are now completed
    const upstream = graph.getNeighbors(feature.id, "upstream");
    const remainingBlockers = upstream.filter((dep) => !isFeatureCompleted(dep));

    if (remainingBlockers.length === 0) {
      nowUnblocked.push(feature);
    } else {
      stillBlocked.push({ feature, remainingBlockers });
    }
  }

  return {
    completedFeatureId,
    nowUnblocked,
    stillBlocked,
  };
}

/**
 * Get all features that are ready to be developed (no incomplete dependencies).
 */
export function getReadyFeatures(graph: FeatureGraph): FeatureNode[] {
  const allFeatures = graph.listFeatures();
  const ready: FeatureNode[] = [];

  for (const feature of allFeatures) {
    // Skip completed features
    if (isFeatureCompleted(feature)) {
      continue;
    }

    // Check if all dependencies are completed
    const validation = validateFeatureDependencies(graph, feature.id);
    if (validation.canProceed) {
      ready.push(feature);
    }
  }

  return ready;
}

/**
 * Format a user-friendly message about dependency blockers.
 */
export function formatDependencyBlockerMessage(
  result: DependencyValidationResult
): string {
  if (result.canProceed) {
    return `Feature "${result.featureId}" is ready for development.`;
  }

  const blockerNames = result.blockedBy.map((b) => b.name).join(", ");
  const suggestedNames = result.suggestedOrder.map((s) => s.name).join(", ");

  let message = `Feature "${result.featureId}" has incomplete dependencies: ${blockerNames}.`;

  if (result.suggestedOrder.length > 0) {
    message += `\n\nSuggested to develop first: ${suggestedNames}`;
  }

  return message;
}

/**
 * Format a user-friendly message about newly unblocked features.
 */
export function formatUnblockedFeaturesMessage(
  result: UnblockedFeaturesResult
): string {
  if (result.nowUnblocked.length === 0) {
    return "No new features were unblocked.";
  }

  const unblockedNames = result.nowUnblocked.map((f) => f.name).join(", ");
  return `The following features are now ready for development: ${unblockedNames}`;
}
