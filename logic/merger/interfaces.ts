// fusion-engine/logic/merger/interfaces.ts

// Re-using conflict types from resolveStep.ts for consistency
import { MergeConflict, MergeConflictReport } from '../../core/pipeline/steps/resolveStep';

export { MergeConflict, MergeConflictReport };

// You might also need AST types if you define AST-specific merged entities here
import * as t from '@babel/types'; // Import Babel AST types

/**
 * Defines a fully merged entity, including its final AST representation.
 * This is the ultimate output of the merge logic for a single entity.
 */
export interface FinalMergedEntity {
  id: string;             // Unified ID (from resolveStep)
  name: string;           // Unified name
  unifiedPath: string;    // Final proposed path in the merged project
  mergedAST: t.File;      // The final merged Abstract Syntax Tree of the entity
  status: 'merged' | 'skipped-conflict' | 'error' | 'merged-with-warnings'; // Status of the merge operation for this entity
  originalPaths: string[]; // Relative paths to all original instances of this entity
  loc: number;            // Lines of code of the final merged entity
  // --- Enhanced Properties for "Super Cool" ---
  mergeTimestamp: number;     // Timestamp of when this entity was merged (Unix timestamp)
  resolvedConflicts?: MergeConflict[]; // Conflicts that were automatically resolved during deep merge (if any)
  needsManualReview?: boolean; // Flag if this merged entity requires manual inspection
  mergedFromCount: number;    // How many original entities contributed to this final merged entity
  // New: Detailed strategy for complex merges
  mergeStrategyUsed?: 'auto-select-dominant' | 'auto-combine-distinct' | 'manual-intervention-required' | 'skipped-due-to-critical-conflict' | 'error'; // ✅ Added 'error' type
  // New: Hashes for integrity check and content traceability
  originalFileHashes?: { path: string; hash: string }[]; // Hashes of original file content for integrity
  // New: Log of transformations applied specifically during merge step
  mergeTransformationLog?: { type: string; details: string }[];
  // New: Heuristic score for merge quality/confidence (0-100)
  mergeQualityScore?: number;
}

/**
 * Summary of the deep smart merge operation.
 */
export interface DeepMergeSummary {
  totalEntitiesAttemptedToMerge: number;
  totalMergedSuccessfully: number;
  totalSkippedDueToConflicts: number; // Entities that resolveStep marked as cannot-be-merged automatically
  totalFailedDuringMergeProcess: number; // Entities that caused errors *during* mergeStep itself (e.g., AST corruption)
  totalLinesOfCodeMerged: number;
  // --- Enhanced Metrics for "Super Cool" ---
  totalAutoResolvedConflicts: number; // Count of conflicts deepSmartMerge handled automatically
  autoResolvedConflictsByType?: { [conflictType: string]: number }; // New: Categorized auto-resolved conflicts
  entitiesWithWarningsAfterMerge: string[]; // List of unified IDs that were merged but have warnings/auto-resolved conflicts
  averageMergeTimePerEntityMs?: number; // Average time taken to merge a single entity
  totalMergeDurationMs: number; // New: Total time for the entire merge step
  // New: Metrics on code impact
  totalCodeAddedLoc?: number; // Total lines of code added by merge (beyond largest original)
  totalCodeRemovedLoc?: number; // Total lines of code removed by merge
  // New: Conceptual: Post-merge validation status
  postMergeLintStatus?: 'passed' | 'failed' | 'skipped' | 'not-applicable'; // ✅ Added 'not-applicable'
  postMergeTypeCheckStatus?: 'passed' | 'failed' | 'skipped' | 'not-applicable'; // ✅ Added 'not-applicable'
}
