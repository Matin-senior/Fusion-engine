// fusion-engine/core/pipeline/steps/resolveAndMergeStep.ts
import chalk from 'chalk';
import path from 'path';

// Import necessary types from modules/analyzer
import { AnalyzedProject, ASTDependency } from '../../../modules/analyzer/workspaceAnalyzer';
import { MergeConflict, MergeConflictReport } from './resolveStep'; // Re-use conflict types from resolveStep
// این تایپ رو از منبع اصلیش، دوباره صادر کن
export type { MergeConflictReport } from './resolveStep';
// --- New Interfaces for Merged Entities ---

/** Base interface for any merged entity. */
export interface MergedEntityBase {
  id: string; // Unique ID for the merged entity (e.g., new unified relative path)
  name: string; // The entity's unified name
  originalPaths: string[]; // Relative paths to all original instances of this entity
  unifiedPath: string; // The proposed new relative path in the merged project
  isShared: boolean; // True if this entity existed in more than one input project
  loc: number; // Aggregated Lines of Code (e.g., average)
}

/** Defines a merged component. */
export interface MergedComponent extends MergedEntityBase {
  type: 'functional' | 'class';
  jsxElementsUsed: { name: string; count: number }[]; // Aggregated JSX elements rendered
  reactHooksUsed: { name: string; count: number }[]; // Aggregated React hooks used
  inferredHOCs: string[]; // List of HOCs inferred
  inferredRole: string; // The most common inferred role
}

/** Defines a merged hook. */
export interface MergedHook extends MergedEntityBase {
  reactHooksUsed: { name: string; count: number }[]; // Hooks used within this hook's definition
  inferredRole: string;
}

/** Defines a merged utility. */
export interface MergedUtility extends MergedEntityBase {
  inferredRole: string;
}

/** Defines a merged context. */
export interface MergedContext extends MergedEntityBase {
  contextType: 'Provider' | 'Consumer' | 'Context'; // The type of context (definition)
  inferredRole: string;
}

export type InternalDependencyMap = Map<string, string>; // Maps original file path to its unified ID
// --- Input & Output Interfaces for ResolveAndMerge Step ---

export type ResolveAndMergeStepInput = {
  analyzedWorkspaces: AnalyzedProject[]; // Output from ScanStep
};


export type ResolveAndMergeStepOutput = {
  mergedEntities: {
    components: MergedComponent[];
    hooks: MergedHook[];
    utilities: MergedUtility[];
    contexts: MergedContext[];
  };
  mergeConflicts: MergeConflictReport;
  internalMap: InternalDependencyMap; // << این خط اضافه شد
  summary: {
    totalInputEntities: number;
    totalMergedEntities: number;
    totalSharedEntities: number;
    totalConflictsReported: number;
    criticalErrors: number;
    warnings: number;
  };
};

// --- Helper for generating Unified Paths ---
function generateUnifiedPath(name: string, entityType: string, baseDir: string = 'merged'): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let folder = baseDir;
    if (entityType === 'component') folder = path.join(baseDir, 'components');
    else if (entityType === 'hook') folder = path.join(baseDir, 'hooks');
    else if (entityType === 'context') folder = path.join(baseDir, 'contexts');
    else if (entityType === 'utility') folder = path.join(baseDir, 'utils');
    else folder = path.join(baseDir, 'common'); // Fallback for other types

    return path.join(folder, `${slug}.ts`); // Using .ts as a generic default
}

/**
 * Helper to compare two arrays of {name, count} objects for structural differences.
 * Order-independent comparison.
 */
function compareNameCountProfiles(profile1: {name: string; count: number}[], profile2: {name: string; count: number}[]): boolean {
    if (profile1.length !== profile2.length) return false;
    const map1 = new Map<string, number>(profile1.map(item => [item.name, item.count]));
    const map2 = new Map<string, number>(profile2.map(item => [item.name, item.count]));

    if (map1.size !== map2.size) return false;

    for (const [name, count] of map1.entries()) {
        if (map2.get(name) !== count) return false;
    }
    return true;
}

/**
 * Helper to aggregate name-count profiles (like reactHooksUsed or jsxElementsUsed) from multiple analyses.
 * Sums counts for shared names.
 */
function aggregateNameCountProfiles(analyses: ASTDependency[], property: 'reactHooksUsed' | 'jsxElementsUsed'): {name: string; count: number}[] {
    const aggregatedMap = new Map<string, number>();
    for (const analysis of analyses) {
        const items = analysis[property];
        for (const item of items) {
            aggregatedMap.set(item.name, (aggregatedMap.get(item.name) || 0) + item.count);
        }
    }
    return Array.from(aggregatedMap.entries()).map(([name, count]) => ({ name, count }));
}

/**
 * Helper for consistent console logging with borders.
 */
function logBoxedMessage(message: string, color: typeof chalk): void {
  const line = '═'.repeat(message.length + 4);
  console.log(color(`╔${line}╗`));
  console.log(color(`║  ${message}  ║`));
  console.log(color(`╚${line}╝`));
}

/**
 * Detects conflicts for a given entity type across its analyses.
 * This function extracts core conflict detection logic.
 */
function detectConflictsForEntity(
    name: string,
    analyses: ASTDependency[],
    entityType: 'component' | 'hook' | 'context' | 'utility'
): { conflicts: MergeConflict[]; canBeMerged: boolean } {
    const conflicts: MergeConflict[] = [];
    let canBeMerged = true;
    const firstAnalysis = analyses[0];
    const firstInferredRole = firstAnalysis.file.inferredRole || 'unknown';

    for (let i = 1; i < analyses.length; i++) {
        const currentAnalysis = analyses[i];
        const currentInferredRole = currentAnalysis.file.inferredRole || 'unknown';

        // Role Mismatch: Critical Error
        if (firstInferredRole !== currentInferredRole) {
            conflicts.push({ type: 'role-mismatch', severity: 'error', message: `Shared ${entityType} "${name}" has conflicting inferred roles.`, details: { roles: { [firstAnalysis.file.relativePath]: firstInferredRole, [currentAnalysis.file.relativePath]: currentInferredRole } }, relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath] });
            canBeMerged = false;
        }
        // LOC Difference: Warning
        if (firstAnalysis.loc !== currentAnalysis.loc) {
            conflicts.push({ type: 'utility-loc-difference', severity: 'warning', message: `Shared ${entityType} "${name}" has different Lines of Code.`, details: { locs: { [firstAnalysis.file.relativePath]: firstAnalysis.loc, [currentAnalysis.file.relativePath]: currentAnalysis.loc } }, relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath] });
        }

        // --- Specific checks based on entity type ---
        if (entityType === 'component') {
            const firstComponent = firstAnalysis.components.find(c => c.name === name);
            const currentComponent = currentAnalysis.components.find(c => c.name === name);
            if (!firstComponent || !currentComponent) continue;

            // Type Difference (Functional vs Class): Critical Error
            if (firstComponent.isFunctional !== currentComponent.isFunctional) {
                conflicts.push({ type: 'component-structural-difference', severity: 'error', message: `Shared component "${name}" has conflicting component types (Functional vs Class).`, details: { types: { [firstAnalysis.file.relativePath]: firstComponent.isFunctional ? 'functional' : 'class', [currentAnalysis.file.relativePath]: currentComponent.isFunctional ? 'functional' : 'class' } }, relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath] });
                canBeMerged = false;
            }
            // JSX Profile Mismatch: Warning
            if (!compareNameCountProfiles(firstAnalysis.jsxElementsUsed, currentAnalysis.jsxElementsUsed)) {
                conflicts.push({ type: 'component-jsx-profile-mismatch', severity: 'warning', message: `Shared component "${name}" renders different JSX elements.`, details: { file1: { path: firstAnalysis.file.relativePath, jsx: firstAnalysis.jsxElementsUsed }, file2: { path: currentAnalysis.file.relativePath, jsx: currentAnalysis.jsxElementsUsed } }, relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath] });
            }
            // Hook Profile Mismatch: Warning
            if (!compareNameCountProfiles(firstAnalysis.reactHooksUsed, currentAnalysis.reactHooksUsed)) {
                conflicts.push({ type: 'component-hook-profile-mismatch', severity: 'warning', message: `Shared component "${name}" uses different React Hooks.`, details: { file1: { path: firstAnalysis.file.relativePath, hooks: firstAnalysis.reactHooksUsed }, file2: { path: currentAnalysis.file.relativePath, hooks: currentAnalysis.reactHooksUsed } }, relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath] });
            }
            // HOC Mismatch: Warning
            const firstHOCs = firstAnalysis.components.filter(c => c.name === name && c.inferredHOC).map(c => c.inferredHOC!);
            const currentHOCs = currentAnalysis.components.filter(c => c.name === name && c.inferredHOC).map(c => c.inferredHOC!);
            if (JSON.stringify(firstHOCs.sort()) !== JSON.stringify(currentHOCs.sort())) {
                conflicts.push({ type: 'component-hoc-mismatch', severity: 'warning', message: `Shared component "${name}" is wrapped by different Higher-Order Components.`, details: { file1: { path: firstAnalysis.file.relativePath, hocs: firstHOCs }, file2: { path: currentAnalysis.file.relativePath, hocs: currentHOCs } }, relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath] });
            }
        } else if (entityType === 'hook') {
            if (!compareNameCountProfiles(firstAnalysis.reactHooksUsed, currentAnalysis.reactHooksUsed)) {
                 conflicts.push({ type: 'component-hook-profile-mismatch', severity: 'warning', message: `Shared hook "${name}" uses different React Hooks in its definition.`, details: { file1: { path: firstAnalysis.file.relativePath, hooks: firstAnalysis.reactHooksUsed }, file2: { path: currentAnalysis.file.relativePath, hooks: currentAnalysis.reactHooksUsed } }, relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath] });
            }
        } else if (entityType === 'context') {
            const firstContextType = firstAnalysis.contextAPIs.find(c => c.name === name && c.type === 'Context')?.type;
            const currentContextType = currentAnalysis.contextAPIs.find(c => c.name === name && c.type === 'Context')?.type;
            if (firstContextType !== currentContextType) {
                conflicts.push({ type: 'context-type-mismatch', severity: 'warning', message: `Shared context "${name}" has different context types (e.g., inferred initial values).`, details: { file1: { path: firstAnalysis.file.relativePath, hooks: firstAnalysis.contextAPIs }, file2: { path: currentAnalysis.file.relativePath, hooks: currentAnalysis.contextAPIs } }, relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath] });
            }
        }
    }
    return { conflicts, canBeMerged };
}


// --- Main ResolveAndMerge Step Function ---
/**
 * The Resolve and Merge Step in the Fusion Engine pipeline.
 * It identifies shared entities (components, hooks, utilities, contexts) across analyzed projects,
 * detects various types of conflicts (structural, role, profile mismatches), and
 * creates a unified representation of these entities for the merged codebase.
 * Entities with critical conflicts are reported but not merged automatically.
 *
 * @param input The input object from the Scan Step.
 * @returns A promise that resolves to the ResolveAndMergeStepOutput.
 */
export async function runResolveAndMergeStep(input: ResolveAndMergeStepInput): Promise<ResolveAndMergeStepOutput> {
  logBoxedMessage('⚙️ Pipeline Step: Resolve & Merge Entities (Deep Fusion)', chalk.blue);

  const mergedComponents: MergedComponent[] = [];
  const mergedHooks: MergedHook[] = [];
  const mergedUtilities: MergedUtility[] = [];
  const mergedContexts: MergedContext[] = [];
  const allConflicts: MergeConflict[] = [];

  const totalInputEntities = { components: 0, hooks: 0, contexts: 0, utilities: 0 };
  const totalSharedEntities = { components: 0, hooks: 0, contexts: 0, utilities: 0 };

  const componentByName = new Map<string, ASTDependency[]>();
  const hookByName = new Map<string, ASTDependency[]>();
  const contextByName = new Map<string, ASTDependency[]>();
  const utilityByName = new Map<string, ASTDependency[]>();

  // START: Declare originalPathToUnifiedId and unifiedEntityMap here so they are in scope
  const originalPathToUnifiedId = new Map<string, string>();
  const unifiedEntityMap = new Map<string, MergedComponent | MergedHook | MergedContext | MergedUtility>();
  // END: Declare originalPathToUnifiedId and unifiedEntityMap here so they are in scope

  // 1. Aggregate all entities from all analyzed projects
  console.log(chalk.cyan(`  Aggregating entities from ${input.analyzedWorkspaces.length} projects...`));
  for (const project of input.analyzedWorkspaces) {
    for (const [, fileAnalysis] of Object.entries(project.analyzedFiles)) { // Destructure for conciseness
      fileAnalysis.components.forEach(comp => {
        componentByName.set(comp.name, (componentByName.get(comp.name) || []).concat(fileAnalysis));
        totalInputEntities.components++;
      });
      Object.keys(fileAnalysis.reactHooksUsed).forEach(hookName => {
        if (fileAnalysis.exports.some(exp => exp.name === hookName && (exp.type === 'function' || exp.type === 'variable'))) {
          hookByName.set(hookName, (hookByName.get(hookName) || []).concat(fileAnalysis));
          totalInputEntities.hooks++;
        }
      });
      fileAnalysis.contextAPIs.forEach(context => {
        if (context.type === 'Context') {
          contextByName.set(context.name, (contextByName.get(context.name) || []).concat(fileAnalysis));
          totalInputEntities.contexts++;
        }
      });
      fileAnalysis.functions.forEach(func => {
        if (!fileAnalysis.components.some(c => c.name === func.name) && func.isExported) {
            utilityByName.set(func.name, (utilityByName.get(func.name) || []).concat(fileAnalysis));
            totalInputEntities.utilities++;
        }
      });
      fileAnalysis.declaredVariables.forEach(variable => {
        if (!fileAnalysis.components.some(c => c.name === variable.name) &&
            !fileAnalysis.contextAPIs.some(ctx => ctx.name === variable.name) && variable.isExported) {
            utilityByName.set(variable.name, (utilityByName.get(variable.name) || []).concat(fileAnalysis));
            totalInputEntities.utilities++;
        }
      });
    }
  }
  console.log(chalk.green(`  Finished aggregation. Found ${totalInputEntities.components} components, ${totalInputEntities.hooks} hooks, etc.`));


  /**
   * Helper function to process a single entity type (e.g., components, hooks) - Defined *inside* runResolveAndMergeStep
   * It relies on closure to access originalPathToUnifiedId and unifiedEntityMap.
   *
   * @param name The name of the entity.
   * @param analyses An array of ASTDependency objects where this entity was found.
   * @param entityType The type of entity ('component', 'hook', 'context', 'utility').
   * @param totalSharedCounter The key in totalSharedEntities to increment.
   */
  const processEntityType = (
    name: string,
    analyses: ASTDependency[],
    entityType: 'component' | 'hook' | 'context' | 'utility',
    totalSharedCounter: keyof typeof totalSharedEntities
  ) => {
    const originalPaths = analyses.map(a => a.file.relativePath);
    const isShared = originalPaths.length > 1;
    const unifiedId = generateUnifiedPath(name, entityType);

    // Conflict detection logic extracted to detectConflictsForEntity
    const { conflicts: currentEntityConflicts, canBeMerged } = detectConflictsForEntity(name, analyses, entityType);
    allConflicts.push(...currentEntityConflicts); // Add conflicts to the global list

    if (isShared && canBeMerged) { // Only increment shared counter if it's actually merged
      totalSharedEntities[totalSharedCounter]++;
    }

    if (canBeMerged) {
        const baseMergedProps = {
            id: unifiedId,
            name: name,
            originalPaths: originalPaths,
            unifiedPath: unifiedId,
            isShared: isShared,
            loc: analyses.reduce((sum, a) => sum + (a.loc || 0), 0) / analyses.length, // Average LOC
        };
        
        let mergedEntity: MergedComponent | MergedHook | MergedContext | MergedUtility;

        if (entityType === 'component') {
            const firstComponentAnalysis = analyses[0].components.find(c => c.name === name);
            mergedEntity = {
                ...baseMergedProps,
                type: firstComponentAnalysis?.isFunctional ? 'functional' : 'class',
                jsxElementsUsed: aggregateNameCountProfiles(analyses, 'jsxElementsUsed'),
                reactHooksUsed: aggregateNameCountProfiles(analyses, 'reactHooksUsed'),
                inferredHOCs: Array.from(new Set(analyses.flatMap(a => a.components.filter(c => c.name === name && c.inferredHOC).map(c => c.inferredHOC!)))),
                inferredRole: analyses[0].file.inferredRole || 'unknown',
            } as MergedComponent;
            mergedComponents.push(mergedEntity as MergedComponent); 
        } else if (entityType === 'hook') {
            mergedEntity = {
                ...baseMergedProps,
                inferredRole: analyses[0].file.inferredRole || 'unknown',
                reactHooksUsed: aggregateNameCountProfiles(analyses, 'reactHooksUsed'),
            } as MergedHook;
            mergedHooks.push(mergedEntity as MergedHook); 
        } else if (entityType === 'context') {
            mergedEntity = {
                ...baseMergedProps,
                contextType: analyses[0].contextAPIs.find(c => c.name === name && c.type === 'Context')?.type || 'Context',
                inferredRole: analyses[0].file.inferredRole || 'unknown',
            } as MergedContext;
            mergedContexts.push(mergedEntity as MergedContext);
        } else if (entityType === 'utility') {
            mergedEntity = {
                ...baseMergedProps,
                inferredRole: analyses[0].file.inferredRole || 'unknown',
            } as MergedUtility;
            mergedUtilities.push(mergedEntity as MergedUtility);
        }
        
        // ✅ Fixed: Use the outer-scoped Maps directly
        originalPaths.forEach(op => originalPathToUnifiedId.set(op, unifiedId));
        unifiedEntityMap.set(unifiedId, mergedEntity!); 
        
        if (currentEntityConflicts.length > 0) {
            console.warn(chalk.yellow(`    ⚠️  ${entityType.charAt(0).toUpperCase() + entityType.slice(1)} "${name}" resolved with warnings. Review report.`));
        } else {
            console.log(chalk.green(`    ✅ ${entityType.charAt(0).toUpperCase() + entityType.slice(1)} "${name}" resolved seamlessly.`));
        }

    } else {
        console.warn(chalk.red(`    ❌ ${entityType.charAt(0).toUpperCase() + entityType.slice(1)} "${name}" cannot be automatically merged due to critical conflicts. Review report.`));
    }
  };


  // 2. Process and Deduplicate Components
  console.log(chalk.cyan(`  Resolving and merging components...`));
  for (const [compName, analyses] of componentByName.entries()) {
    processEntityType(compName, analyses, 'component', 'components'); 
  }
  console.log(chalk.green(`  Resolved and prepared ${mergedComponents.length} unique components.`));

  // 3. Process and Deduplicate Hooks
  console.log(chalk.cyan(`  Resolving and merging hooks...`));
  for (const [hookName, analyses] of hookByName.entries()) {
    processEntityType(hookName, analyses, 'hook', 'hooks'); 
  }
  console.log(chalk.green(`  Resolved and prepared ${mergedHooks.length} unique hooks.`));

  // 4. Process and Deduplicate Contexts
  console.log(chalk.cyan(`  Resolving and merging contexts...`));
  for (const [contextName, analyses] of contextByName.entries()) {
    processEntityType(contextName, analyses, 'context', 'contexts'); 
  }
  console.log(chalk.green(`  Resolved and prepared ${mergedContexts.length} unique contexts.`));

  // 5. Process and Deduplicate Utilities
  console.log(chalk.cyan(`  Resolving and merging utilities...`));
  for (const [utilName, analyses] of utilityByName.entries()) {
    processEntityType(utilName, analyses, 'utility', 'utilities'); 
  }
  console.log(chalk.green(`  Resolved and prepared ${mergedUtilities.length} unique utilities.`));


  // 6. Compile Conflict Report & Summary
  const conflictReport: MergeConflictReport = {
    hasConflicts: allConflicts.length > 0,
    criticalErrors: allConflicts.filter(c => c.severity === 'error'),
    warnings: allConflicts.filter(c => c.severity === 'warning'),
    totalConflicts: allConflicts.length,
  };

  const outputSummary = {
    totalInputEntities: totalInputEntities.components + totalInputEntities.hooks + totalInputEntities.contexts + totalInputEntities.utilities,
    totalMergedEntities: mergedComponents.length + mergedHooks.length + mergedContexts.length + mergedUtilities.length,
    totalSharedEntities: totalSharedEntities.components + totalSharedEntities.hooks + totalSharedEntities.contexts + totalSharedEntities.utilities,
    totalConflictsReported: conflictReport.totalConflicts,
    criticalErrors: conflictReport.criticalErrors.length,
    warnings: conflictReport.warnings.length,
  };

  // --- Final Summary Display ---
  logBoxedMessage('Merge Resolution & Unification Step Summary', chalk.blue);
  console.log(chalk.bold(`  Total Input Entities (Components, Hooks, etc.): ${outputSummary.totalInputEntities}`));
  console.log(chalk.bold(`  Total Shared Entities Found: ${outputSummary.totalSharedEntities}`));
  console.log(chalk.bold(`  Total Merged Entities (Unique & Resolvable): ${outputSummary.totalMergedEntities}`));
  console.log(chalk.bold(`  Total Conflicts Reported: ${outputSummary.totalConflictsReported}`));
  console.log(chalk.bold(`  Critical Errors: `) + chalk.red.bold(outputSummary.criticalErrors.toString()));
  console.log(chalk.bold(`  Warnings: `) + chalk.yellow.bold(outputSummary.warnings.toString()));

  if (conflictReport.hasConflicts) {
      console.warn(chalk.yellow(`\n  Detected Conflicts:`));
      if (conflictReport.criticalErrors.length > 0) {
          console.error(chalk.red.bold(`    ❌ Critical Conflicts preventing automatic merge:`));
          conflictReport.criticalErrors.forEach(c => console.error(chalk.red(`      - [${c.type}] ${c.message} (Files: ${c.relatedFiles.join(', ')})`)));
      }
      if (conflictReport.warnings.length > 0) {
          console.warn(chalk.yellow.bold(`    ⚠️  Warnings (review recommended):`));
          conflictReport.warnings.forEach(c => console.warn(chalk.yellow(`      - [${c.type}] ${c.message} (Files: ${c.relatedFiles.join(', ')})`)));
      }
  } else {
      console.log(chalk.green('\n  🎉 No conflicts detected! Entities are ready for seamless merging.'));
  }
  logBoxedMessage('Resolve & Merge Step completed successfully.', chalk.green);


  return {
    mergedEntities: {
      components: mergedComponents,
      hooks: mergedHooks,
      utilities: mergedUtilities,
      contexts: mergedContexts,
    },
    mergeConflicts: conflictReport,
    internalMap: originalPathToUnifiedId,
    summary: outputSummary,
  };
}