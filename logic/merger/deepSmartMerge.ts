// fusion-engine/logic/merger/deepSmartMerge.ts
import * as t from '@babel/types';
import chalk from 'chalk';
import generate from '@babel/generator';

// Import types and helpers from normalization step and internal interfaces
import { NormalizedComponent, NormalizedHook, NormalizedUtility, NormalizedContext } from '../../core/pipeline/steps/normalizeStep';
import { AnalyzedProject, ASTDependency } from '../../modules/analyzer/workspaceAnalyzer'; // Correct import for AnalyzedProject and ASTDependency
import { FinalMergedEntity, MergeConflict } from './interfaces';
import { parseCodeToAst, mergeAsts } from './mergeUtils';

/**
 * Performs a "deep smart merge" operation for a set of related entities (e.g., components with the same name).
 * This function takes the already normalized code and produces a final, merged AST representation.
 * It's where the actual AST manipulation for merging happens based on insights from previous steps.
 *
 * @param entityName The common name of the entities being merged.
 * @param entitiesToMerge An array of NormalizedComponent/Hook/Utility/Context objects that are to be merged.
 * @param originalAnalyzedFileMap A map of original file paths to their ASTDependency for context.
 * @param autoResolvableWarnings Optional: Warnings from resolve step that deepSmartMerge might try to handle.
 * @returns A promise resolving to a FinalMergedEntity, or null if merging is impossible.
 */
export async function deepSmartMerge(
    entityName: string,
    entitiesToMerge: (NormalizedComponent | NormalizedHook | NormalizedUtility | NormalizedContext)[],
    originalAnalyzedFileMap: Map<string, ASTDependency>,
    autoResolvableWarnings: MergeConflict[] = [] // New parameter for warnings to potentially auto-resolve
): Promise<FinalMergedEntity | null> {
    const mergeStartTime = Date.now();
    let finalAst: t.File | null = null;
    const allOriginalPaths: string[] = [];
    let totalLoc = 0;
    const resolvedConflicts: MergeConflict[] = []; // Conflicts resolved by this step
    let mergeQualityScore = 100; // Start with high quality, decrease if warnings/complex merges
    let mergeStrategyUsed: FinalMergedEntity['mergeStrategyUsed'] = 'auto-select-dominant';
    const mergeTransformationLog: FinalMergedEntity['mergeTransformationLog'] = [];

    if (!entitiesToMerge || entitiesToMerge.length === 0) {
        console.warn(chalk.yellow(`    ⚠️  deepSmartMerge: No entities provided for "${entityName}". Skipping.`));
        return null;
    }

    // Initialize autoResolvedConflictsByType for cases where no autoResolvableWarnings are passed but score changes
    const autoResolvedConflictsByType: { [conflictType: string]: number } = {};
    
    // Process auto-resolvable warnings if any
    if (autoResolvableWarnings.length > 0) {
        console.log(chalk.gray(`    Attempting to auto-resolve ${autoResolvableWarnings.length} warnings for "${entityName}"...`));
        autoResolvableWarnings.forEach(warning => {
            resolvedConflicts.push({ ...warning, message: `Auto-resolved: ${warning.message}` });
            mergeTransformationLog.push({ type: 'auto-resolve-conflict', details: warning.message });
            mergeQualityScore -= 5;
            // Count auto-resolved conflicts by type
            autoResolvedConflictsByType[warning.type] = (autoResolvedConflictsByType[warning.type] || 0) + 1;
        });
        if (mergeQualityScore < 0) mergeQualityScore = 0;
    }

    const dominantEntity = entitiesToMerge[0]; 
    
    try {
        const originalFileAnalysis = originalAnalyzedFileMap.get(dominantEntity.originalPaths[0]);
        if (!originalFileAnalysis) {
            throw new Error(`Original analysis for dominant entity ${dominantEntity.name} (${dominantEntity.originalPaths[0]}) not found.`);
        }
        
        finalAst = parseCodeToAst(dominantEntity.normalizedCode, originalFileAnalysis.file.absolutePath, originalFileAnalysis.file.extension);

        if (entitiesToMerge.length > 1) {
            mergeStrategyUsed = 'auto-combine-distinct';
            for (let i = 1; i < entitiesToMerge.length; i++) {
                const incomingEntity = entitiesToMerge[i];
                const incomingOriginalAnalysis = originalAnalyzedFileMap.get(incomingEntity.originalPaths[0]);
                if (!incomingOriginalAnalysis) {
                    console.warn(chalk.yellow(`      ⚠️  Original analysis for incoming entity ${incomingEntity.name} (${incomingEntity.originalPaths[0]}) not found. Skipping its merge.`));
                    mergeTransformationLog.push({type: 'skipped-incoming-entity', details: `Analysis not found for ${incomingEntity.originalPaths[0]}`});
                    mergeQualityScore -= 10;
                    continue;
                }
                const incomingAst = parseCodeToAst(incomingEntity.normalizedCode, incomingOriginalAnalysis.file.absolutePath, incomingOriginalAnalysis.file.extension);
                
                // Ensure finalAst is not null before passing to mergeAsts
                if (finalAst) { 
                    const tempMergedAst = mergeAsts(finalAst, incomingAst);
                    if (generate(finalAst, { compact: true }).code !== generate(tempMergedAst, { compact: true }).code) {
                         finalAst = tempMergedAst;
                         mergeTransformationLog.push({type: 'ast-combined', details: `Combined with ${incomingEntity.name} from ${incomingEntity.originalPaths[0]}`});
                         mergeQualityScore -= 2;
                    }
                } else {
                    finalAst = incomingAst; // If finalAst was null, set the first valid incoming AST as base
                }
            }
        }

    } catch (error: any) {
        console.error(chalk.red(`    ❌ Critical error during deep merge process for "${entityName}": ${error.message}`));
        console.error(chalk.red(error.stack || ''));
        return {
            id: entitiesToMerge[0].id,
            name: entityName,
            unifiedPath: entitiesToMerge[0].unifiedPath,
            mergedAST: t.file(t.program([t.expressionStatement(t.stringLiteral(`// Error during merge for ${entityName}: ${error.message}`))])),
            status: 'error',
            originalPaths: entitiesToMerge.map(e => e.originalPaths[0]),
            loc: entitiesToMerge.reduce((sum, e) => sum + e.loc, 0) / entitiesToMerge.length,
            mergeTimestamp: Date.now(),
            mergedFromCount: entitiesToMerge.length,
            needsManualReview: true,
            mergeStrategyUsed: 'error',
            mergeQualityScore: 0,
            mergeTransformationLog: mergeTransformationLog,
        };
    }

    if (!finalAst) {
        console.error(chalk.red(`    ❌ No valid AST could be generated for "${entityName}".`));
        return {
            id: entitiesToMerge[0].id,
            name: entityName,
            unifiedPath: entitiesToMerge[0].unifiedPath,
            mergedAST: t.file(t.program([t.expressionStatement(t.stringLiteral(`// No final AST for ${entityName}`))])),
            status: 'error',
            originalPaths: entitiesToMerge.map(e => e.originalPaths[0]),
            loc: entitiesToMerge.reduce((sum, e) => sum + e.loc, 0) / entitiesToMerge.length,
            mergeTimestamp: Date.now(),
            mergedFromCount: entitiesToMerge.length,
            needsManualReview: true,
            mergeStrategyUsed: 'error',
            mergeQualityScore: 0,
            mergeTransformationLog: mergeTransformationLog,
        };
    }

    const finalMergedCode = generate(finalAst).code;
    const finalLoc = finalMergedCode.split('\n').length;
    const mergeEndTime = Date.now();

    console.log(chalk.green(`    ✔ Successfully deep-merged "${entityName}". Final LOC: ${finalLoc}`));

    let finalStatus: FinalMergedEntity['status'] = 'merged';
    if (resolvedConflicts.length > 0) {
        finalStatus = 'merged-with-warnings';
    }
    const needsManualReview = mergeQualityScore < 70 || resolvedConflicts.length > 0;

    return {
        id: entitiesToMerge[0].id,
        name: entityName,
        unifiedPath: entitiesToMerge[0].unifiedPath,
        mergedAST: finalAst,
        status: finalStatus,
        originalPaths: allOriginalPaths.length > 0 ? Array.from(new Set(allOriginalPaths)) : entitiesToMerge.map(e => e.originalPaths[0]), // Ensure unique paths
        loc: finalLoc,
        mergeTimestamp: mergeEndTime,
        resolvedConflicts: resolvedConflicts.length > 0 ? resolvedConflicts : undefined,
        needsManualReview: needsManualReview,
        mergedFromCount: entitiesToMerge.length,
        mergeStrategyUsed: mergeStrategyUsed,
        mergeTransformationLog: mergeTransformationLog.length > 0 ? mergeTransformationLog : undefined,
        mergeQualityScore: mergeQualityScore,
        // Add originalFileHashes here if implemented
    };
}
