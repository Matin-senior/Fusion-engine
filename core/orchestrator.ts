// fusion-engine/core/orchestrator.ts
import chalk from 'chalk';
import * as t from '@babel/types';

// Import validator functions
import { runValidation, ValidationReport } from './validator';

// Import pipeline steps and their types
import { runScanStep, ScanStepInput, ScanStepOutput } from './pipeline/steps/scanStep';
import { runResolveAndMergeStep, ResolveAndMergeStepInput, ResolveAndMergeStepOutput, MergedComponent, MergedHook, MergedUtility, MergedContext, MergeConflictReport, InternalDependencyMap } from './pipeline/steps/resolveAndMergeStep';
import { runNormalizeStep, NormalizationInput, NormalizationOutput, NormalizedComponent, NormalizedHook, NormalizedUtility, NormalizedContext } from './pipeline/steps/normalizeStep';
import { runMergeStep, MergeStepInput, MergeStepOutput, DeepMergeSummary } from './pipeline/steps/mergeStep';
import { runRenderStep, RenderStepInput, RenderStepOutput } from './pipeline/steps/renderStep';

// Import types from other modules
import { AnalyzedProject } from '../modules/analyzer/workspaceAnalyzer';
import { FinalMergedEntity } from '../logic/merger/interfaces';

// --- Interfaces for Orchestrator ---

export interface OrchestratorOptions {
  projectRoots: string[];
  config?: UserFusionConfig;
  logger?: Logger;
}

export interface UserFusionConfig {
  mergeStrategy?: 'default' | 'prioritize-source' | 'manual-review-all-conflicts';
  aliases?: { [alias: string]: string };
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
  getLogs?(): string[];
}

export interface FusionContext {
  // Inputs
  projectRoots: string[];
  config: UserFusionConfig;
  logger: Logger;

  // Validation
  validationReport?: ValidationReport;
  validationDurationMs?: number;

  // Scan
  analyzedWorkspaces?: AnalyzedProject[];
  scanDurationMs?: number;
  scanSummary?: ScanStepOutput['scanSummary'];

  // Resolve & Merge
  mergedEntities?: ResolveAndMergeStepOutput['mergedEntities'];
  resolveMergeConflicts?: MergeConflictReport;
  internalMap?: InternalDependencyMap;
  resolveMergeDurationMs?: number;

  // Normalize
  normalizedEntities?: NormalizationOutput['normalizedEntities'];
  normalizationSummary?: NormalizationOutput['normalizationSummary'];
  normalizeDurationMs?: number;

  // Merge
  finalMergedEntities?: FinalMergedEntity[];
  finalMergeSummary?: DeepMergeSummary;
  mergeDurationMs?: number;

  // Render
  outputFiles?: Map<string, string>;
  renderDurationMs?: number;
  renderSummary?: RenderStepOutput['renderSummary'];

  // Overall Status
  currentStepStatus: 'pending' | 'running' | 'completed' | 'failed';
  overallSuccess: boolean;
  overallErrorMessage?: string;
  totalOrchestrationDurationMs?: number;
}

export interface OrchestratorResult {
  success: boolean;
  codeOutput?: Map<string, string>;
  finalReport?: FusionContext;
  error?: string;
}

const defaultLogger: Logger = {
  info: (msg: string) => console.log(chalk.gray(msg)),
  warn: (msg: string) => console.warn(chalk.yellow(msg)),
  error: (msg: string) => console.error(chalk.red(msg)),
  debug: (msg: string) => console.log(chalk.blue(msg)),
};

// Conceptual Post-Merge Validation Functions
async function runPostMergeLint(mergedEntities: FinalMergedEntity[]): Promise<string> {
    return 'skipped';
}
async function runPostMergeTypeCheck(mergedEntities: FinalMergedEntity[]): Promise<string> {
    return 'skipped';
}


/**
 * The main orchestrator for the Fusion Engine.
 * It manages and executes the entire process pipeline.
 */
export async function runFusionOrchestrator(options: OrchestratorOptions): Promise<OrchestratorResult> {
  const orchestrationStartTime = Date.now();
  const context: FusionContext = {
    projectRoots: options.projectRoots,
    config: options.config || {},
    logger: options.logger || defaultLogger,
    currentStepStatus: 'pending',
    overallSuccess: false,
  };

  context.logger.info(chalk.magenta('\n╔═══════════════════════════════════════════════════════════════════╗'));
  context.logger.info(chalk.magenta('║             ✨ Fusion Engine Orchestrator: Initiating             ║'));
  context.logger.info(chalk.magenta('╚═══════════════════════════════════════════════════════════════════╝'));

  try {
    context.currentStepStatus = 'running';

    // --- Step 1: Initial Validation ---
    context.logger.info(chalk.yellow('\n--- Running Initial Project Validation ---'));
    const validationStepStartTime = Date.now();
    try {
        context.validationReport = await runValidation(context.projectRoots);
        context.validationDurationMs = Date.now() - validationStepStartTime;
        if (context.validationReport.overallStatus === 'failed') {
            throw new Error(`Initial validation failed: ${context.validationReport.summary.criticalErrors} critical error(s) found.`);
        }
        context.logger.info(chalk.green(`✔ Initial validation completed in ${context.validationDurationMs} ms.`));
    } catch (valError: any) {
        context.validationDurationMs = Date.now() - validationStepStartTime;
        throw valError;
    }

    // --- Step 2: Pipeline Execution ---
    context.logger.info(chalk.yellow('\n--- Starting Fusion Pipeline Execution ---'));

    // 2.1. Scan Step
    context.logger.info(chalk.blue('\n  Running Scan Step...'));
    const scanStepStartTime = Date.now();
    try {
        const scanInput: ScanStepInput = { sourceProjects: context.projectRoots };
        const scanOutput = await runScanStep(scanInput);
        context.analyzedWorkspaces = scanOutput.analyzedWorkspaces;
        context.scanSummary = scanOutput.scanSummary;
        context.scanDurationMs = Date.now() - scanStepStartTime;
        context.logger.info(chalk.green(`  ✔ Scan Step completed in ${context.scanDurationMs} ms.`));
    } catch (scanError: any) {
        context.scanDurationMs = Date.now() - scanStepStartTime;
        throw scanError;
    }

    // 2.2. Resolve & Merge Step
    context.logger.info(chalk.blue('\n  Running Resolve & Merge Step...'));
    const resolveMergeStepStartTime = Date.now();
    try {
        if (!context.analyzedWorkspaces?.length) {
            throw new Error("No workspaces to resolve. Scan step might have failed.");
        }
        const resolveMergeInput: ResolveAndMergeStepInput = { analyzedWorkspaces: context.analyzedWorkspaces };
        const resolveMergeOutput = await runResolveAndMergeStep(resolveMergeInput);
        context.mergedEntities = resolveMergeOutput.mergedEntities;
        context.resolveMergeConflicts = resolveMergeOutput.mergeConflicts;
        context.internalMap = resolveMergeOutput.internalMap;
        context.resolveMergeDurationMs = Date.now() - resolveMergeStepStartTime;
        context.logger.info(chalk.green(`  ✔ Resolve & Merge Step completed in ${context.resolveMergeDurationMs} ms.`));
        if (context.resolveMergeConflicts?.criticalErrors.length) {
            throw new Error(`Critical conflicts detected during Resolve & Merge step. Aborting.`);
        }
    } catch (resolveMergeError: any) {
        context.resolveMergeDurationMs = Date.now() - resolveMergeStepStartTime;
        throw resolveMergeError;
    }

    // 2.3. Normalize Step
    context.logger.info(chalk.blue('\n  Running Normalize Step...'));
    const normalizeStepStartTime = Date.now();
    try {
        if (!context.analyzedWorkspaces || !context.mergedEntities || !context.internalMap) {
            throw new Error('Missing dependencies for Normalize Step. Previous steps might have failed.');
        }
        // ✅ اصلاح: ورودی صحیح بر اساس تعریف تایپ در `normalizeStep.ts`
        const normalizationInput: NormalizationInput = {
            analyzedWorkspaces: context.analyzedWorkspaces,
            mergedEntities: context.mergedEntities,
            internalMap: context.internalMap,
        };
        const normalizationOutput = await runNormalizeStep(normalizationInput);
        context.normalizedEntities = normalizationOutput.normalizedEntities;
        context.normalizationSummary = normalizationOutput.normalizationSummary;
        context.normalizeDurationMs = Date.now() - normalizeStepStartTime;
        context.logger.info(chalk.green(`  ✔ Normalize Step completed in ${context.normalizeDurationMs} ms.`));
    } catch (normalizeError: any) {
        context.normalizeDurationMs = Date.now() - normalizeStepStartTime;
        throw normalizeError;
    }

    // 2.4. Merge Step (AST Merge)
    context.logger.info(chalk.blue('\n  Running Merge Step...'));
    const mergeStepStartTime = Date.now();
    try {
        if (!context.normalizedEntities || !context.analyzedWorkspaces || !context.resolveMergeConflicts) {
            throw new Error('Missing dependencies for Merge Step. Previous steps might have failed.');
        }
        // ✅ اصلاح: ورودی صحیح بر اساس تعریف تایپ در `mergeStep.ts`
        const mergeInput: MergeStepInput = {
            normalizedEntities: context.normalizedEntities,
            analyzedWorkspaces: context.analyzedWorkspaces,
            mergeConflicts: context.resolveMergeConflicts,
        };
        const mergeOutput = await runMergeStep(mergeInput);
        context.finalMergedEntities = mergeOutput.finalMergedEntities;
        // ✅ اصلاح: نام پراپرتی `mergeSummary` صحیح است
        context.finalMergeSummary = mergeOutput.mergeSummary;
        context.mergeDurationMs = Date.now() - mergeStepStartTime;
        context.logger.info(chalk.green(`  ✔ Merge Step completed in ${context.mergeDurationMs} ms.`));
    } catch (mergeError: any) {
        context.mergeDurationMs = Date.now() - mergeStepStartTime;
        throw mergeError;
    }

    // 2.5. Render Step
    context.logger.info(chalk.blue('\n  Running Render Step...'));
    const renderStepStartTime = Date.now();
    try {
        if (!context.finalMergedEntities) {
            throw new Error('No final merged entities found. Merge step might have failed.');
        }
        // ✅ اصلاح: ورودی صحیح بر اساس تعریف تایپ در `renderStep.ts`
        const renderInput: RenderStepInput = {
            finalMergedEntities: context.finalMergedEntities
        };
        const renderOutput = await runRenderStep(renderInput);
        context.outputFiles = renderOutput.outputFiles;
        context.renderSummary = renderOutput.renderSummary;
        context.renderDurationMs = Date.now() - renderStepStartTime;
        context.logger.info(chalk.green(`  ✔ Render Step completed in ${context.renderDurationMs} ms.`));
    } catch (renderError: any) {
        context.renderDurationMs = Date.now() - renderStepStartTime;
        throw renderError;
    }

    // --- Final Validation and Summary ---
    context.logger.info(chalk.yellow('\n--- Running Final Validations (Lint & Type Check) ---'));
    const lintResult = await runPostMergeLint(context.finalMergedEntities || []);
    const typeCheckResult = await runPostMergeTypeCheck(context.finalMergedEntities || []);
    context.logger.info(`Post-Merge Lint: ${lintResult}`);
    context.logger.info(`Post-Merge Type Check: ${typeCheckResult}`);

    context.totalOrchestrationDurationMs = Date.now() - orchestrationStartTime;
    context.currentStepStatus = 'completed';
    context.overallSuccess = true;

    context.logger.info(chalk.green(`\n✅ Fusion Engine completed successfully in ${context.totalOrchestrationDurationMs} ms.`));
    return {
        success: true,
        codeOutput: context.outputFiles,
        finalReport: context,
    };

  } catch (error: any) {
    context.currentStepStatus = 'failed';
    context.overallSuccess = false;
    context.overallErrorMessage = error.message;
    context.logger.error(chalk.red.bold(`\n❌ Fusion Engine failed at step: ${context.overallErrorMessage}`));
    context.logger.error(chalk.red(error.stack || ''));
    context.totalOrchestrationDurationMs = Date.now() - orchestrationStartTime;

    return {
      success: false,
      error: context.overallErrorMessage,
      finalReport: context,
    };
  }
}
