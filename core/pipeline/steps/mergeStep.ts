// fusion-engine/core/pipeline/steps/mergeStep.ts
import chalk from 'chalk';
import generate from '@babel/generator'; // For generating final code from merged AST
import * as t from '@babel/types'; // For AST types if needed for final checks

// Import types from previous pipeline steps
import { NormalizationInput, NormalizationOutput, NormalizedComponent, NormalizedHook, NormalizedUtility, NormalizedContext } from './normalizeStep';
import { ResolveAndMergeStepOutput } from './resolveAndMergeStep'; // For access to conflicts

// Import types and functions from logic/merger
import { deepSmartMerge } from '../../../logic/merger/deepSmartMerge';
import { FinalMergedEntity, DeepMergeSummary, MergeConflictReport } from '../../../logic/merger/interfaces'; // Re-use interfaces
import { ASTDependency } from '../../../modules/analyzer/workspaceAnalyzer'; // ✅ مسیر اصلاح شد: ../../../modules/analyzer/workspaceAnalyzer

/**
 * Input for the Merge Step, directly from the Normalize Step's output.
 */
export type MergeStepInput = {
  normalizedEntities: NormalizationOutput['normalizedEntities']; // Normalized code entities
  analyzedWorkspaces: NormalizationInput['analyzedWorkspaces']; // Original analyzed workspaces for context
  mergeConflicts: ResolveAndMergeStepOutput['mergeConflicts']; // Conflicts reported from resolveAndMergeStep
};

/**
 * Output of the Merge Step. Contains the final merged ASTs/code representations.
 */
export type MergeStepOutput = {
  finalMergedEntities: FinalMergedEntity[]; // All entities that were successfully merged or skipped due to conflicts
  mergeSummary: DeepMergeSummary;
  unresolvedConflicts: MergeConflictReport; // Re-reporting critical conflicts that prevented merge
};

/**
 * Helper for consistent console logging with borders.
 */
function logBoxedMessage(message: string, color: typeof chalk): void {
  const line = '═'.repeat(message.length + 4);
  console.log(color(`╔${line}╗`));
  console.log(color(`║${' '.repeat(Math.floor(line.length / 2) - Math.floor(message.length / 2))}${message}${' '.repeat(Math.ceil(line.length / 2) - Math.ceil(message.length / 2))}║`));
  console.log(color(`╚${line}╝`));
}

/**
 * Groups normalized entities by their unified ID.
 * Since entities are normalized representations of potentially shared original entities,
 * we group them here for `deepSmartMerge`.
 */
function groupNormalizedEntities(
    normalizedComponents: NormalizedComponent[],
    normalizedHooks: NormalizedHook[],
    normalizedUtilities: NormalizedUtility[],
    normalizedContexts: NormalizedContext[]
): Map<string, (NormalizedComponent | NormalizedHook | NormalizedUtility | NormalizedContext)[]> {
    const grouped = new Map<string, (NormalizedComponent | NormalizedHook | NormalizedUtility | NormalizedContext)[]>();
    [...normalizedComponents, ...normalizedHooks, ...normalizedUtilities, ...normalizedContexts].forEach(entity => {
        if (!grouped.has(entity.id)) {
            grouped.set(entity.id, []);
        }
        grouped.get(entity.id)!.push(entity);
    });
    return grouped;
}

/**
 * The Merge Step in the Fusion Engine pipeline.
 * It takes the normalized entities, applies the deep smart merge logic for shared entities,
 * and produces the final merged AST representations. It also reports a summary of the merge process.
 *
 * @param input The input object containing normalized entities, original analysis, and conflicts.
 * @returns A promise that resolves to the MergeStepOutput.
 */
export async function runMergeStep(input: MergeStepInput): Promise<MergeStepOutput> {
  const startTime = Date.now(); // Start timing the merge step
  logBoxedMessage('⚙️ Pipeline Step: Merge Entities (Actual Code Fusion)', chalk.blue);

  const finalMergedEntities: FinalMergedEntity[] = [];
  const mergeSummary: DeepMergeSummary = {
    totalEntitiesAttemptedToMerge: 0,
    totalMergedSuccessfully: 0,
    totalSkippedDueToConflicts: 0,
    totalFailedDuringMergeProcess: 0,
    totalLinesOfCodeMerged: 0,
    totalAutoResolvedConflicts: 0,
    autoResolvedConflictsByType: {}, // Initialize to empty object
    entitiesWithWarningsAfterMerge: [],
    totalMergeDurationMs: 0,
    // postMergeLintStatus: 'skipped', // Default to skipped if not implemented
    // postMergeTypeCheckStatus: 'skipped', // Default to skipped if not implemented
  };

  // Create a map from original relative path to its ASTDependency for easy lookup by deepSmartMerge
  const originalAnalyzedFileMap = new Map<string, ASTDependency>();
  input.analyzedWorkspaces.forEach(ws => {
      Object.entries(ws.analyzedFiles).forEach(([relPath, astDep]) => {
          originalAnalyzedFileMap.set(relPath, astDep);
      });
  });

  // Group entities by their unified ID for deep merging
  const groupedEntities = groupNormalizedEntities(
      input.normalizedEntities.components,
      input.normalizedEntities.hooks,
      input.normalizedEntities.utilities,
      input.normalizedEntities.contexts
  );
  
  mergeSummary.totalEntitiesAttemptedToMerge = groupedEntities.size;

  for (const [unifiedId, entities] of groupedEntities.entries()) {
    const entityName = entities[0].name; // Name of the unified entity
    const isShared = entities[0].isShared;

    // Get any critical conflicts for this specific entity from previous step
    const criticalConflicts = input.mergeConflicts.criticalErrors.filter(c => entities[0].originalPaths.some(op => c.relatedFiles.includes(op)));
    // Also get warnings that were reported but can be auto-resolved by mergeStep if needed
    const warningsToAutoResolve = input.mergeConflicts.warnings.filter(c => entities[0].originalPaths.some(op => c.relatedFiles.includes(op)));


    if (criticalConflicts.length > 0) {
        console.warn(chalk.red(`    ❌ Skipping merge for "${entityName}" (ID: ${unifiedId}) due to critical conflicts from previous step.`));
        mergeSummary.totalSkippedDueToConflicts++;
        finalMergedEntities.push({
            id: unifiedId,
            name: entityName,
            unifiedPath: entities[0].unifiedPath,
            mergedAST: t.file(t.program([t.expressionStatement(t.stringLiteral(`// Merge skipped for ${entityName} due to critical conflicts.`))])), // Placeholder AST
            status: 'skipped-conflict',
            originalPaths: entities[0].originalPaths,
            loc: entities[0].loc,
            mergeTimestamp: Date.now(),
            mergedFromCount: entities.length,
            mergeStrategyUsed: 'skipped-due-to-critical-conflict',
            needsManualReview: true,
            mergeTransformationLog: [], // Ensure this is initialized
        });
        continue;
    }

    console.log(chalk.cyan(`  Merging entity: "${entityName}" (ID: ${unifiedId})${isShared ? chalk.gray(' - Shared') : ''}`));
    try {
        // deepSmartMerge will now receive warnings to potentially auto-resolve them
        const mergedEntity = await deepSmartMerge(
            entityName,
            entities,
            originalAnalyzedFileMap,
            warningsToAutoResolve // Pass warnings to deepSmartMerge for potential auto-resolution
        );

        if (mergedEntity) {
            finalMergedEntities.push(mergedEntity);
            if (mergedEntity.status === 'merged' || mergedEntity.status === 'merged-with-warnings') {
                mergeSummary.totalMergedSuccessfully++;
                mergeSummary.totalLinesOfCodeMerged += mergedEntity.loc;
                // Update auto-resolved conflict counts
                if (mergedEntity.resolvedConflicts) {
                    mergeSummary.totalAutoResolvedConflicts += mergedEntity.resolvedConflicts.length;
                    mergedEntity.resolvedConflicts.forEach(conf => {
                        mergeSummary.autoResolvedConflictsByType![conf.type] = (mergeSummary.autoResolvedConflictsByType![conf.type] || 0) + 1;
                    });
                }
                if (mergedEntity.status === 'merged-with-warnings' || mergedEntity.needsManualReview) {
                    mergeSummary.entitiesWithWarningsAfterMerge.push(mergedEntity.id);
                }
                console.log(chalk.green(`    ✔ Merged successfully: "${entityName}" (${mergedEntity.status}).`));
            } else if (mergedEntity.status === 'skipped-conflict') {
                mergeSummary.totalSkippedDueToConflicts++;
                console.warn(chalk.yellow(`    ⚠️  Skipped merge for "${entityName}" as decided by deepSmartMerge.`));
            } else if (mergedEntity.status === 'error') {
                mergeSummary.totalFailedDuringMergeProcess++;
                console.error(chalk.red(`    ❌ Failed to merge "${entityName}" within deepSmartMerge.`));
            }
        } else { // deepSmartMerge returned null for some reason (should ideally return an error status)
            mergeSummary.totalFailedDuringMergeProcess++;
            finalMergedEntities.push({
                id: unifiedId,
                name: entityName,
                unifiedPath: entities[0].unifiedPath,
                mergedAST: t.file(t.program([t.expressionStatement(t.stringLiteral(`// Unknown error during merge for ${entityName}`))])),
                status: 'error',
                originalPaths: entities[0].originalPaths,
                loc: entities[0].loc,
                mergeTimestamp: Date.now(),
                mergedFromCount: entities.length,
                needsManualReview: true,
                mergeStrategyUsed: 'error',
                mergeQualityScore: 0,
                mergeTransformationLog: [], // Ensure this is initialized
            });
            console.error(chalk.red(`    ❌ Unknown deepSmartMerge failure for "${entityName}".`));
        }
    } catch (error: any) {
        mergeSummary.totalFailedDuringMergeProcess++;
        finalMergedEntities.push({
            id: unifiedId,
            name: entityName,
            unifiedPath: entities[0].unifiedPath,
            mergedAST: t.file(t.program([t.expressionStatement(t.stringLiteral(`// Critical error during merge for ${entityName}`))])),
            status: 'error',
            originalPaths: entities[0].originalPaths,
            loc: entities[0].loc,
            mergeTimestamp: Date.now(),
            mergedFromCount: entities.length,
            needsManualReview: true,
            mergeStrategyUsed: 'error',
            mergeQualityScore: 0,
            mergeTransformationLog: [], // Ensure this is initialized
        });
        console.error(chalk.red.bold(`\n❌ CRITICAL ERROR during merging "${entityName}": ${error.message}`));
        console.error(chalk.red(error.stack || ''));
    }
  }
    const endTime = Date.now();
    mergeSummary.totalMergeDurationMs = endTime - startTime;
    mergeSummary.averageMergeTimePerEntityMs = mergeSummary.totalEntitiesAttemptedToMerge > 0 
        ? mergeSummary.totalMergeDurationMs / mergeSummary.totalEntitiesAttemptedToMerge 
        : 0;

  // --- Post-Merge Validation (Conceptual) ---
  console.log(chalk.yellow('\n─── Running Post-Merge Validations (Conceptual) ───'));
  // This is where you would integrate tools like ESLint or TypeScript compiler
  // to validate the *merged* ASTs/code for correctness.
  try {
      // ✅ Fixed: Ensure runPostRenderLint and runPostRenderTypeCheck are imported from renderStep.ts if they are helpers there
      // If these functions are meant to be generic validators, they should be in logic/validators
      // For now, assume they are defined locally or globally accessible in renderStep.ts's scope
      // For this context, it's safer to define conceptual helpers or assume they are external services
      const runPostMergeLint = async (_entities: FinalMergedEntity[]): Promise<'passed' | 'failed' | 'skipped' | 'not-applicable'> => {
          return 'skipped';
      };
      const runPostMergeTypeCheck = async (_entities: FinalMergedEntity[]): Promise<'passed' | 'failed' | 'skipped' | 'not-applicable'> => {
          return 'skipped';
      };



            mergeSummary.postMergeLintStatus = await runPostMergeLint(finalMergedEntities); // ✅ اینجا اصلاح شد: از آرایه‌ای که به صورت محلی ساخته شده استفاده کن
      if (mergeSummary.postMergeLintStatus === 'passed') {
          console.log(chalk.green('    ✔ Post-merge linting passed.'));
      } else if (mergeSummary.postMergeLintStatus === 'failed') {
          console.error(chalk.red('    ❌ Post-merge linting failed. Review linting reports.'));
          mergeSummary.entitiesWithWarningsAfterMerge.push('POST_MERGE_LINT_FAILURE'); // Add a general flag
      } else {
          console.log(chalk.gray(`    Post-merge linting status: ${mergeSummary.postMergeLintStatus}.`));
      }

     mergeSummary.postMergeTypeCheckStatus = await runPostMergeTypeCheck(finalMergedEntities); // ✅ اینجا اصلاح شد: از آرایه‌ای که به صورت محلی ساخته شده استفاده کن و اشتباه تایپی (runPostRenderTypeCheck) هم برطرف شد.
      
      if (mergeSummary.postMergeTypeCheckStatus === 'passed') {
          console.log(chalk.green('    ✔ Post-merge type checking passed.'));
      } else if (mergeSummary.postMergeTypeCheckStatus === 'failed') {
          console.error(chalk.red('    ❌ Post-merge type checking failed. Review type check reports.'));
          mergeSummary.entitiesWithWarningsAfterMerge.push('POST_MERGE_TYPE_CHECK_FAILURE'); // Add a general flag
      } else {
          console.log(chalk.gray(`    Post-merge type checking status: ${mergeSummary.postMergeTypeCheckStatus}.`));
      }
  } catch (validationError: any) {
      console.error(chalk.red(`    ❌ Error during post-merge validation phase: ${validationError.message}`));
      // Set status based on actual validation results
      mergeSummary.postMergeLintStatus = 'failed';
      mergeSummary.postMergeTypeCheckStatus = 'failed';
      mergeSummary.entitiesWithWarningsAfterMerge.push('POST_MERGE_VALIDATION_ERROR');
  }


  // --- Final Summary Display ---
  logBoxedMessage('Merge Step Summary', chalk.blue);
  console.log(chalk.bold(`  Total Entities Attempted to Merge: ${mergeSummary.totalEntitiesAttemptedToMerge}`));
  console.log(chalk.bold(`  Successfully Merged: ${mergeSummary.totalMergedSuccessfully}`));
  console.log(chalk.bold(`  Skipped (Prev Issues): ${mergeSummary.totalSkippedDueToConflicts || 0}`)); // Corrected property name for clarity
  console.log(chalk.bold(`  Failed During Merging: `) + chalk.red.bold(mergeSummary.totalFailedDuringMergeProcess.toString()));
  console.log(chalk.bold(`  Total Lines of Code Merged: ${mergeSummary.totalLinesOfCodeMerged}`));
  console.log(chalk.bold(`  Total Auto-Resolved Conflicts: ${mergeSummary.totalAutoResolvedConflicts}`));
  if (Object.keys(mergeSummary.autoResolvedConflictsByType!).length > 0) {
      console.log(chalk.bold(`  Auto-Resolved Conflicts by Type:`));
      for (const [type, count] of Object.entries(mergeSummary.autoResolvedConflictsByType!)) {
          console.log(chalk.gray(`    - ${type}: ${count}`));
      }
  }
  if (mergeSummary.entitiesWithWarningsAfterMerge.length > 0) {
      console.warn(chalk.yellow(`  ⚠️  Entities Merged with Warnings/Errors: ${mergeSummary.entitiesWithWarningsAfterMerge.length} (IDs: ${mergeSummary.entitiesWithWarningsAfterMerge.slice(0, 5).join(', ')}${mergeSummary.entitiesWithWarningsAfterMerge.length > 5 ? '...' : ''})`));
  }
  console.log(chalk.bold(`  Total Merge Duration: ${mergeSummary.totalMergeDurationMs} ms`));
  console.log(chalk.bold(`  Average Merge Time per Entity: ${mergeSummary.averageMergeTimePerEntityMs?.toFixed(2)} ms`));
  console.log(chalk.bold(`  Post-Merge Lint Status: ${mergeSummary.postMergeLintStatus || 'skipped'}`));
  console.log(chalk.bold(`  Post-Merge Type Check Status: ${mergeSummary.postMergeTypeCheckStatus || 'skipped'}`));

  // Final overall status based on merge results
  let overallStatus: 'passed' | 'warnings' | 'failed' = 'passed';
  if (mergeSummary.totalFailedDuringMergeProcess > 0) {
      overallStatus = 'failed';
  } else if (mergeSummary.totalSkippedDueToConflicts > 0 || mergeSummary.entitiesWithWarningsAfterMerge.length > 0) {
      overallStatus = 'warnings';
  }

  if (overallStatus === 'failed') {
      console.error(chalk.red.bold('\n❌ Merge Step completed with CRITICAL ERRORS!'));
  } else if (overallStatus === 'warnings') {
      console.warn(chalk.yellow.bold('\n⚠️ Merge Step completed with WARNINGS.'));
  } else {
      console.log(chalk.green('\n🎉 All entities merged successfully! The codebase is fused!'));
  }
  logBoxedMessage('Merge Step completed successfully.', chalk.green);

  return { finalMergedEntities, mergeSummary, unresolvedConflicts: input.mergeConflicts };
}
