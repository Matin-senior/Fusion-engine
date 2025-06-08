// fusion-engine/core/pipeline/steps/resolveStep.ts
import chalk from 'chalk';
import path from 'path';

// Import necessary types from modules/analyzer
import { AnalyzedProject, ASTDependency } from '../../../modules/analyzer/workspaceAnalyzer';

// --- Input & Output Interfaces for Resolve Step ---

/**
 * Input for the Resolve Step, directly from the Scan Step's output.
 */
export type ResolveStepInput = {
  analyzedWorkspaces: AnalyzedProject[]; // The result of the comprehensive workspace analysis.
};

/**
 * Represents a resolved component after analysis across multiple projects.
 */
export interface ResolvedComponent {
  id: string; // A unique ID for the resolved component (e.g., new unified relative path)
  name: string; // The component's name
  type: 'functional' | 'class';
  originalPaths: string[]; // Relative paths to all original instances of this component
  unifiedPath: string; // The proposed new relative path in the merged project
  isShared: boolean; // True if this component exists in more than one input project
  loc: number; // Aggregated Lines of Code (can be average or sum if needed)
  jsxElementsUsed: { name: string; count: number }[]; // Aggregated JSX elements rendered by this component
  reactHooksUsed: { name: string; count: number }[]; // Aggregated React hooks used
  inferredHOCs: string[]; // List of HOCs inferred for this component
  inferredRole: string; // The most common inferred role from projectScanner
  // Add other aggregated properties as needed
}

/**
 * Defines a resolved hook.
 */
export interface ResolvedHook {
  id: string;
  name: string;
  originalPaths: string[];
  unifiedPath: string;
  isShared: boolean;
  loc: number;
  inferredRole: string;
  reactHooksUsed: { name: string; count: number }[]; // Hooks used within this hook's definition
}

/**
 * Defines a resolved context.
 */
export interface ResolvedContext {
  id: string;
  name: string;
  originalPaths: string[];
  unifiedPath: string;
  type: 'Provider' | 'Consumer' | 'Context';
  isShared: boolean;
  inferredRole: string;
}

/**
 * Defines a resolved utility (general function/variable).
 */
export interface ResolvedUtility {
  id: string;
  name: string;
  originalPaths: string[];
  unifiedPath: string;
  isShared: boolean;
  loc: number;
  inferredRole: string;
}

/**
 * Represents a conflict detected during resolution.
 */
export interface MergeConflict {
  type: 'name-collision' | 'role-mismatch' | 'component-structural-difference' | 'component-hook-profile-mismatch' | 'component-jsx-profile-mismatch' | 'component-hoc-mismatch' | 'utility-loc-difference' | 'context-type-mismatch' | 'other';
  severity: 'error' | 'warning';
  message: string;
  details: Record<string, any>; // Detailed object of conflict properties
  relatedFiles: string[]; // Relative paths of files involved in the conflict
}

/**
 * Reports all conflicts found during the merge resolution phase.
 */
export interface MergeConflictReport {
  hasConflicts: boolean;
  criticalErrors: MergeConflict[]; // Conflicts that might block merging
  warnings: MergeConflict[]; // Conflicts that should be reviewed but might not block
  totalConflicts: number;
}

/**
 * An internal map of how original files/entities resolve to new unified entities.
 * Key: Original relative file path, Value: Unified ID or null if not unified.
 * This can also map original component/hook names to their unified IDs.
 */
export interface InternalDependencyMap {
  unifiedEntityMap: Map<string, ResolvedComponent | ResolvedHook | ResolvedContext | ResolvedUtility>; // unifiedId -> resolved entity
  originalPathToUnifiedId: Map<string, string>; // original relative path -> unifiedId
}


/**
 * Output of the Resolve Step, containing an intelligent map of mergeable components and detected conflicts.
 */
export type ResolveStepOutput = {
  resolvedComponents: ResolvedComponent[];
  resolvedHooks: ResolvedHook[];
  resolvedContexts: ResolvedContext[];
  resolvedUtilities: ResolvedUtility[];
  internalMap: InternalDependencyMap;
  conflictReport: MergeConflictReport;
};

// --- Helper for generating Unified Paths ---
// A simple heuristic for unified paths: use the name of the entity, potentially prefixed
function generateUnifiedPath(name: string, type: string, baseDir: string = 'merged'): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    let folder = baseDir;
    if (type === 'component') folder = path.join(baseDir, 'components');
    else if (type === 'hook') folder = path.join(baseDir, 'hooks');
    else if (type === 'context') folder = path.join(baseDir, 'contexts');
    else if (type === 'utility') folder = path.join(baseDir, 'utils');
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

    if (map1.size !== map2.size) return false; // Should be same as length if no duplicates, but good check

    for (const [name, count] of map1.entries()) {
        if (map2.get(name) !== count) return false;
    }
    return true;
}

/**
 * Helper to aggregate reactHooksUsed or jsxElementsUsed from multiple analyses.
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


// --- Main Resolve Step Function ---
/**
 * The Resolve Step in the Fusion Engine pipeline.
 * It processes the detailed analysis from the Scan Step, identifies shared
 * components, hooks, contexts, and utilities, and detects structural and
 * semantic conflicts. It transforms raw analysis data into a structured
 * format ready for merging, providing a sophisticated conflict report.
 *
 * @param input The input object from the Scan Step.
 * @returns A promise that resolves to the ResolveStepOutput.
 */
export async function runResolveStep(input: ResolveStepInput): Promise<ResolveStepOutput> {
  console.log(chalk.blue('\n╔═══════════════════════════════════════════════════════════════════╗'));
  console.log(chalk.blue('║         ⚙️ Pipeline Step: Resolve & Unify Components (Deep)         ║'));
  console.log(chalk.blue('╚═══════════════════════════════════════════════════════════════════╝'));

  const resolvedComponents: ResolvedComponent[] = [];
  const resolvedHooks: ResolvedHook[] = [];
  const resolvedContexts: ResolvedContext[] = [];
  const resolvedUtilities: ResolvedUtility[] = [];
  const allConflicts: MergeConflict[] = [];

  const unifiedEntityMap = new Map<string, ResolvedComponent | ResolvedHook | ResolvedContext | ResolvedUtility>();
  const originalPathToUnifiedId = new Map<string, string>();

  // Temporary maps to group entities by name for de-duplication and conflict detection
  const componentByName = new Map<string, ASTDependency[]>();
  const hookByName = new Map<string, ASTDependency[]>();
  const contextByName = new Map<string, ASTDependency[]>();
  const utilityByName = new Map<string, ASTDependency[]>(); // For functions & variables

  // 1. Aggregate all entities from all analyzed projects
  for (const project of input.analyzedWorkspaces) {
    for (const [relativePath, fileAnalysis] of Object.entries(project.analyzedFiles)) {
      // Components
      fileAnalysis.components.forEach(comp => {
        if (!componentByName.has(comp.name)) componentByName.set(comp.name, []);
        componentByName.get(comp.name)!.push(fileAnalysis); // Store full analysis for comparison
      });
      // Hooks (from ReactHooksUsed, assuming the hook is defined in this file)
      Object.keys(fileAnalysis.reactHooksUsed).forEach(hookName => {
        const isHookDefinedAndExported = fileAnalysis.exports.some(exp => exp.name === hookName && (exp.type === 'function' || exp.type === 'variable'));
        if (isHookDefinedAndExported) {
          if (!hookByName.has(hookName)) hookByName.set(hookName, []);
          hookByName.get(hookName)!.push(fileAnalysis);
        }
      });
      // Contexts
      fileAnalysis.contextAPIs.forEach(context => {
        if (context.type === 'Context') { // Only track the definition of the context
          if (!contextByName.has(context.name)) contextByName.set(context.name, []);
          contextByName.get(context.name)!.push(fileAnalysis);
        }
      });
      // Utilities (Functions/Variables not classified as components/hooks/contexts)
      fileAnalysis.functions.forEach(func => {
        // Exclude components already captured by 'fileAnalysis.components'
        if (!fileAnalysis.components.some(c => c.name === func.name) && func.isExported) { // Only exported functions as utilities
            if (!utilityByName.has(func.name)) utilityByName.set(func.name, []);
            utilityByName.get(func.name)!.push(fileAnalysis);
        }
      });
      fileAnalysis.declaredVariables.forEach(variable => {
        // Exclude components and contexts already captured
        if (!fileAnalysis.components.some(c => c.name === variable.name) &&
            !fileAnalysis.contextAPIs.some(ctx => ctx.name === variable.name) && variable.isExported) { // Only exported variables as utilities
            if (!utilityByName.has(variable.name)) utilityByName.set(variable.name, []);
            utilityByName.get(variable.name)!.push(fileAnalysis);
        }
      });
    }
  }
  console.log(chalk.green(`  Aggregated entities from ${input.analyzedWorkspaces.length} projects.`));


  // 2. Resolve and Deduplicate Components
  for (const [compName, analyses] of componentByName.entries()) {
    const originalPaths = analyses.map(a => a.file.relativePath);
    const isShared = originalPaths.length > 1;
    const unifiedId = generateUnifiedPath(compName, 'component');

    let isConflicting = false;
    let conflictDetails: Record<string, any> = {};

    if (isShared) {
        const firstAnalysis = analyses[0];
        const firstComponent = firstAnalysis.components.find(c => c.name === compName); // Ensure we get the correct component from this analysis
        const firstInferredRole = firstAnalysis.file.inferredRole || 'unknown';

        for (let i = 1; i < analyses.length; i++) {
            const currentAnalysis = analyses[i];
            const currentComponent = currentAnalysis.components.find(c => c.name === compName);
            const currentInferredRole = currentAnalysis.file.inferredRole || 'unknown';

            // Role Mismatch
            if (firstInferredRole !== currentInferredRole) {
                allConflicts.push({
                    type: 'role-mismatch',
                    severity: 'error', // Critical: Different roles indicate different purposes
                    message: `Shared component "${compName}" has conflicting inferred roles.`,
                    details: { roles: { [firstAnalysis.file.relativePath]: firstInferredRole, [currentAnalysis.file.relativePath]: currentInferredRole } },
                    relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath],
                });
                isConflicting = true;
            }

            if (!firstComponent || !currentComponent) continue; // Should not happen, but for safety

            // Type Difference (Functional vs Class)
            if (firstComponent.isFunctional !== currentComponent.isFunctional) {
                allConflicts.push({
                    type: 'component-structural-difference',
                    severity: 'error', // Critical: Functional vs Class is a major difference
                    message: `Shared component "${compName}" has conflicting component types (Functional vs Class).`,
                    details: { types: { [firstAnalysis.file.relativePath]: firstComponent.isFunctional ? 'functional' : 'class', [currentAnalysis.file.relativePath]: currentComponent.isFunctional ? 'functional' : 'class' } },
                    relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath],
                });
                isConflicting = true;
            }
            // LOC Difference
            if (firstAnalysis.loc !== currentAnalysis.loc) {
                isConflicting = true;
                conflictDetails.locDifference = true;
            }
            // JSX Profile Mismatch (which JSX elements are rendered)
            if (!compareNameCountProfiles(firstAnalysis.jsxElementsUsed, currentAnalysis.jsxElementsUsed)) {
                allConflicts.push({
                    type: 'component-jsx-profile-mismatch',
                    severity: 'warning',
                    message: `Shared component "${compName}" renders different JSX elements.`,
                    details: { 
                        file1: { path: firstAnalysis.file.relativePath, jsx: firstAnalysis.jsxElementsUsed },
                        file2: { path: currentAnalysis.file.relativePath, jsx: currentAnalysis.jsxElementsUsed }
                    },
                    relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath],
                });
                isConflicting = true;
            }
            // Hook Profile Mismatch (which hooks are used)
            if (!compareNameCountProfiles(firstAnalysis.reactHooksUsed, currentAnalysis.reactHooksUsed)) {
                allConflicts.push({
                    type: 'component-hook-profile-mismatch',
                    severity: 'warning',
                    message: `Shared component "${compName}" uses different React Hooks.`,
                    details: { 
                        file1: { path: firstAnalysis.file.relativePath, hooks: firstAnalysis.reactHooksUsed },
                        file2: { path: currentAnalysis.file.relativePath, hooks: currentAnalysis.reactHooksUsed }
                    },
                    relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath],
                });
                isConflicting = true;
            }
            // HOC Mismatch (if wrapped by different HOCs)
            const firstHOCs = firstAnalysis.components.filter(c => c.name === compName && c.inferredHOC).map(c => c.inferredHOC!);
            const currentHOCs = currentAnalysis.components.filter(c => c.name === compName && c.inferredHOC).map(c => c.inferredHOC!);
            if (JSON.stringify(firstHOCs.sort()) !== JSON.stringify(currentHOCs.sort())) { // Simple stringify for comparison
                allConflicts.push({
                    type: 'component-hoc-mismatch',
                    severity: 'warning',
                    message: `Shared component "${compName}" is wrapped by different Higher-Order Components.`,
                    details: { 
                        file1: { path: firstAnalysis.file.relativePath, hocs: firstHOCs },
                        file2: { path: currentAnalysis.file.relativePath, hocs: currentHOCs }
                    },
                    relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath],
                });
                isConflicting = true;
            }
        }

        // ✅ Fixed: Ensure currentAnalysis.file.relativePath is accessible here
        // The original issue was due to 'currentAnalysis' being out of scope for the outer 'if' block.
        // We now filter based on originalPaths, which is always in scope.
        if (isConflicting && Object.keys(conflictDetails).length > 0) {
            const specificConflictTypes = allConflicts.filter(c => originalPaths.some(op => c.relatedFiles.includes(op))).map(c => c.type).join(', ');
            if (!specificConflictTypes.includes('component-structural-difference')) {
                allConflicts.push({
                    type: 'component-structural-difference',
                    severity: 'warning',
                    message: `Shared component "${compName}" has general structural differences across projects.`,
                    details: conflictDetails,
                    relatedFiles: originalPaths,
                });
            }
        }
    }

    const resolvedComp: ResolvedComponent = {
      id: unifiedId,
      name: compName,
      type: analyses[0].components.find(c => c.name === compName)?.isFunctional ? 'functional' : 'class',
      originalPaths: originalPaths,
      unifiedPath: unifiedId,
      isShared: isShared,
      loc: analyses.reduce((sum, a) => sum + (a.loc || 0), 0) / analyses.length, // Average LOC for shared
      // ✅ Fixed: Use aggregateNameCountProfiles for consistent typing and aggregation
      jsxElementsUsed: aggregateNameCountProfiles(analyses, 'jsxElementsUsed'), 
      reactHooksUsed: aggregateNameCountProfiles(analyses, 'reactHooksUsed'), 
      inferredHOCs: analyses.flatMap(a => a.components.filter(c => c.name === compName && c.inferredHOC).map(c => c.inferredHOC!)), // Aggregated HOCs
      inferredRole: analyses[0].file.inferredRole || 'unknown', // Take role from the first
    };
    resolvedComponents.push(resolvedComp);
    originalPathToUnifiedId.set(originalPaths[0], unifiedId); // Map original path to unified ID (only first one for simplicity, can be expanded)
    unifiedEntityMap.set(unifiedId, resolvedComp);
  }
  console.log(chalk.green(`  Resolved ${resolvedComponents.length} unique components.`));


  // 3. Resolve and Deduplicate Hooks, Contexts, Utilities (with enhanced conflict detection)
  // For Hooks:
  for (const [hookName, analyses] of hookByName.entries()) {
    const originalPaths = analyses.map(a => a.file.relativePath);
    const isShared = originalPaths.length > 1;
    const unifiedId = generateUnifiedPath(hookName, 'hook');

    let isConflicting = false;
    if (isShared) {
        const firstAnalysis = analyses[0];
        const firstInferredRole = firstAnalysis.file.inferredRole || 'unknown';
        for (let i = 1; i < analyses.length; i++) {
            const currentAnalysis = analyses[i];
            const currentInferredRole = currentAnalysis.file.inferredRole || 'unknown';

            // Role Mismatch
            if (firstInferredRole !== currentInferredRole) {
                allConflicts.push({ type: 'role-mismatch', severity: 'error', message: `Shared hook "${hookName}" has conflicting inferred roles.`, details: { roles: { [firstAnalysis.file.relativePath]: firstInferredRole, [currentAnalysis.file.relativePath]: currentInferredRole } }, relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath] });
                isConflicting = true;
            }
            // LOC Difference
            if (firstAnalysis.loc !== currentAnalysis.loc) {
                isConflicting = true;
                allConflicts.push({ type: 'utility-loc-difference', severity: 'warning', message: `Shared hook "${hookName}" has different LOC across projects.`, details: { locs: analyses.map(a => `${a.file.relativePath}: ${a.loc}`) }, relatedFiles: originalPaths });
            }
            // Hook Profile Mismatch (Hooks used WITHIN this hook definition)
            if (!compareNameCountProfiles(firstAnalysis.reactHooksUsed, currentAnalysis.reactHooksUsed)) {
                 allConflicts.push({ type: 'component-hook-profile-mismatch', severity: 'warning', message: `Shared hook "${hookName}" uses different React Hooks in its definition.`, details: { file1: { path: firstAnalysis.file.relativePath, hooks: firstAnalysis.reactHooksUsed }, file2: { path: currentAnalysis.file.relativePath, hooks: currentAnalysis.reactHooksUsed } }, relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath] });
                 isConflicting = true;
            }
        }
        if (isConflicting) console.warn(chalk.yellow(`    ⚠️  Conflicts for hook "${hookName}" detected.`));
    }

    const resolvedHook: ResolvedHook = {
        id: unifiedId,
        name: hookName,
        originalPaths: originalPaths,
        unifiedPath: unifiedId,
        isShared: isShared,
        loc: analyses.reduce((sum, a) => sum + (a.loc || 0), 0) / analyses.length,
        inferredRole: analyses[0].file.inferredRole || 'unknown',
        // ✅ Fixed: Use aggregateNameCountProfiles for consistent typing and aggregation
        reactHooksUsed: aggregateNameCountProfiles(analyses, 'reactHooksUsed'), 
    };
    resolvedHooks.push(resolvedHook);
    originalPathToUnifiedId.set(originalPaths[0], unifiedId);
    unifiedEntityMap.set(unifiedId, resolvedHook);
  }
  console.log(chalk.green(`  Resolved ${resolvedHooks.length} unique hooks.`));

  // For Contexts:
  for (const [contextName, analyses] of contextByName.entries()) {
    const originalPaths = analyses.map(a => a.file.relativePath);
    const isShared = originalPaths.length > 1;
    const unifiedId = generateUnifiedPath(contextName, 'context');

    let isConflicting = false;
    if (isShared) {
        const firstAnalysis = analyses[0];
        const firstContextType = firstAnalysis.contextAPIs.find(c => c.name === contextName && c.type === 'Context')?.type;
        const firstInferredRole = firstAnalysis.file.inferredRole || 'unknown';

        for (let i = 1; i < analyses.length; i++) {
            const currentAnalysis = analyses[i];
            const currentContextType = currentAnalysis.contextAPIs.find(c => c.name === contextName && c.type === 'Context')?.type;
            const currentInferredRole = currentAnalysis.file.inferredRole || 'unknown';

            // Role Mismatch
            if (firstInferredRole !== currentInferredRole) {
                allConflicts.push({ type: 'role-mismatch', severity: 'error', message: `Shared context "${contextName}" has conflicting inferred roles.`, details: { roles: { [firstAnalysis.file.relativePath]: firstInferredRole, [currentAnalysis.file.relativePath]: currentInferredRole } }, relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath] });
                isConflicting = true;
            }
            // Context Type Mismatch (e.g., if AST could infer different initial values or structures -- advanced)
            if (firstContextType !== currentContextType) {
                allConflicts.push({ type: 'context-type-mismatch', severity: 'warning', message: `Shared context "${contextName}" has different context types (e.g., inferred initial values).`, details: { file1: firstAnalysis.file.relativePath, file2: currentAnalysis.file.relativePath }, relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath] });
                isConflicting = true;
            }
        }
        if (isConflicting) console.warn(chalk.yellow(`    ⚠️  Conflicts for context "${contextName}" detected.`));
    }

    const resolvedContext: ResolvedContext = {
        id: unifiedId,
        name: contextName,
        originalPaths: originalPaths,
        unifiedPath: unifiedId,
        isShared: isShared,
        type: analyses[0].contextAPIs.find(c => c.name === contextName && c.type === 'Context')?.type || 'Context', // Assuming it's 'Context'
        inferredRole: analyses[0].file.inferredRole || 'unknown',
    };
    resolvedContexts.push(resolvedContext);
    originalPathToUnifiedId.set(originalPaths[0], unifiedId);
    unifiedEntityMap.set(unifiedId, resolvedContext);
  }
  console.log(chalk.green(`  Resolved ${resolvedContexts.length} unique contexts.`));

  // For Utilities:
  for (const [utilName, analyses] of utilityByName.entries()) {
    const originalPaths = analyses.map(a => a.file.relativePath);
    const isShared = originalPaths.length > 1;
    const unifiedId = generateUnifiedPath(utilName, 'utility');

    let isConflicting = false;
    if (isShared) {
        const firstAnalysis = analyses[0];
        const firstInferredRole = firstAnalysis.file.inferredRole || 'unknown';
        for (let i = 1; i < analyses.length; i++) {
            const currentAnalysis = analyses[i];
            const currentInferredRole = currentAnalysis.file.inferredRole || 'unknown';

            // Role Mismatch
            if (firstInferredRole !== currentInferredRole) {
                allConflicts.push({ type: 'role-mismatch', severity: 'error', message: `Shared utility "${utilName}" has conflicting inferred roles.`, details: { roles: { [firstAnalysis.file.relativePath]: firstInferredRole, [currentAnalysis.file.relativePath]: currentInferredRole } }, relatedFiles: [firstAnalysis.file.relativePath, currentAnalysis.file.relativePath] });
                isConflicting = true;
            }
            // LOC Difference
            if (firstAnalysis.loc !== currentAnalysis.loc) {
                allConflicts.push({ type: 'utility-loc-difference', severity: 'warning', message: `Shared utility "${utilName}" has different LOC across projects.`, details: { locs: analyses.map(a => `${a.file.relativePath}: ${a.loc}`) }, relatedFiles: originalPaths });
                isConflicting = true; // Mark as conflicting
            }
        }
        if (isConflicting) console.warn(chalk.yellow(`    ⚠️  Conflicts for utility "${utilName}" detected.`));
    }

    const resolvedUtility: ResolvedUtility = {
        id: unifiedId,
        name: utilName,
        originalPaths: originalPaths,
        unifiedPath: unifiedId,
        isShared: isShared,
        loc: analyses.reduce((sum, a) => sum + (a.loc || 0), 0) / analyses.length,
        inferredRole: analyses[0].file.inferredRole || 'unknown',
    };
    resolvedUtilities.push(resolvedUtility);
    originalPathToUnifiedId.set(originalPaths[0], unifiedId);
    unifiedEntityMap.set(unifiedId, resolvedUtility);
  }
  console.log(chalk.green(`  Resolved ${resolvedUtilities.length} unique utilities.`));


  // 4. Compile Conflict Report
  const conflictReport: MergeConflictReport = {
    hasConflicts: allConflicts.length > 0,
    criticalErrors: allConflicts.filter(c => c.severity === 'error'),
    warnings: allConflicts.filter(c => c.severity === 'warning'),
    totalConflicts: allConflicts.length,
  };
  if (conflictReport.hasConflicts) {
      console.warn(chalk.yellow(`\n  Conflicts detected during resolution:`));
      if (conflictReport.criticalErrors.length > 0) {
          console.error(chalk.red.bold(`    ❌ Critical Conflicts: ${conflictReport.criticalErrors.length}`));
          conflictReport.criticalErrors.forEach(c => console.error(chalk.red(`      - [${c.type}] ${c.message} (Files: ${c.relatedFiles.join(', ')})`)));
      }
      if (conflictReport.warnings.length > 0) {
          console.warn(chalk.yellow.bold(`    ⚠️  Warnings: ${conflictReport.warnings.length}`));
          conflictReport.warnings.forEach(c => console.warn(chalk.yellow(`      - [${c.type}] ${c.message} (Files: ${c.relatedFiles.join(', ')})`)));
      }
  } else {
      console.log(chalk.green('\n  🎉 No conflicts detected during resolution!'));
  }


  // 5. Build Internal Dependency Map
  const internalMap: InternalDependencyMap = {
    unifiedEntityMap: unifiedEntityMap,
    originalPathToUnifiedId: originalPathToUnifiedId,
  };


  console.log(chalk.blue('╚═══════════════════════════════════════════════════════════════════╗'));
  console.log(chalk.green('✅ Resolve Step completed successfully.'));

  return {
    resolvedComponents,
    resolvedHooks,
    resolvedContexts,
    resolvedUtilities,
    internalMap,
    conflictReport,
  };
}
