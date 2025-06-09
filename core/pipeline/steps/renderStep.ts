// fusion-engine/core/pipeline/steps/renderStep.ts
import chalk from 'chalk';
import generate from '@babel/generator'; // For generating code from AST
import * as t from '@babel/types';     // For Babel AST types (e.g., for placeholder ASTs)
import path from 'path'; // ✅ اضافه شد: برای ا
// Import types from previous pipeline steps
import { MergeStepOutput } from './mergeStep';
import { FinalMergedEntity } from '../../../logic/merger/interfaces'; // Import FinalMergedEntity

// --- Input & Output Interfaces for Render Step ---

/**
 * Defines the input for the Render Step.
 */
export type RenderStepInput = {
  finalMergedEntities: MergeStepOutput['finalMergedEntities']; // The final merged entities from the Merge Step.
  // Potentially include mergeSummary or conflicts if needed for rendering decisions/reports
};

/**
 * Defines the output of the Render Step.
 * A map where keys are destination file paths and values are the final code content.
 */
export type RenderStepOutput = {
  outputFiles: Map<string, string>; // Map of unified file path -> generated code content
  renderSummary: {
    totalEntitiesToRender: number;
    successfullyRendered: number;
    skippedRender: number; // Entities skipped due to conflicts or errors from previous steps
    failedToRender: number; // Entities that caused errors *during* rendering (e.g., AST corruption)
    totalLinesOfCodeRendered: number; // Total LOC of all successfully rendered files
    // --- Enhanced Metrics for "Super Cool" ---
    totalRenderDurationMs: number; // Total time for the entire render step
    averageRenderTimePerEntityMs?: number; // Average time taken to render a single entity
    entitiesWithRenderWarnings: string[]; // IDs of entities rendered but with warnings/issues
    postRenderLintStatus?: 'passed' | 'failed' | 'skipped' | 'not-applicable'; // Conceptual: Linting status post-render
    postRenderTypeCheckStatus?: 'passed' | 'failed' | 'skipped' | 'not-applicable'; // Conceptual: Type checking status post-render
    totalCodeAddedLoc?: number; // Conceptual: Total LOC added compared to original largest entity
  };
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

// --- Conceptual Post-Render Validation Functions (Not implemented here) ---
// These functions would live in logic/validators or similar and integrate with external tools (ESLint, TypeScript compiler)
async function runPostRenderLint(mergedEntities: FinalMergedEntity[]): Promise<'passed' | 'failed' | 'skipped' | 'not-applicable'> {
    // console.log(chalk.gray('      Running post-render linting... (Conceptual)'));
    await new Promise(resolve => setTimeout(resolve, 50)); // Simulate work
    return 'skipped'; // Placeholder
}

async function runPostRenderTypeCheck(mergedEntities: FinalMergedEntity[]): Promise<'passed' | 'failed' | 'skipped' | 'not-applicable'> {
    // console.log(chalk.gray('      Running post-render type checking... (Conceptual)'));
    await new Promise(resolve => setTimeout(resolve, 50)); // Simulate work
    return 'skipped'; // Placeholder
}


/**
 * The Render Step in the Fusion Engine pipeline.
 * It takes the final merged ASTs from the Merge Step, converts them into code strings,
 * and prepares them for writing to disk. This version includes enhanced reporting
 * and conceptual post-render validation integration.
 *
 * @param input The input object containing the final merged entities.
 * @returns A promise that resolves to the RenderStepOutput.
 */
export async function runRenderStep(input: RenderStepInput): Promise<RenderStepOutput> {
  const renderStartTime = Date.now(); // Start timing the render step
  logBoxedMessage('⚙️ Pipeline Step: Render Final Code (Generation)', chalk.blue);

  const outputFiles = new Map<string, string>();
  const renderSummary: RenderStepOutput['renderSummary'] = {
    totalEntitiesToRender: input.finalMergedEntities.length,
    successfullyRendered: 0,
    skippedRender: 0,
    failedToRender: 0,
    totalLinesOfCodeRendered: 0,
    totalRenderDurationMs: 0, // Will be calculated at the end
    entitiesWithRenderWarnings: [],
    totalCodeAddedLoc: 0, // Placeholder
  };

  if (!input.finalMergedEntities || input.finalMergedEntities.length === 0) {
    console.warn(chalk.yellow('    ⚠️  Render step received no entities to render. Skipping.'));
    return { outputFiles, renderSummary };
  }

  console.log(chalk.cyan(`  Attempting to render ${input.finalMergedEntities.length} merged entities...`));

  for (const entity of input.finalMergedEntities) {
    console.log(chalk.gray(`    Processing "${entity.name}" (ID: ${entity.id})...`));
    if (entity.status === 'skipped-conflict' || entity.status === 'error') {
      console.warn(chalk.yellow(`    ⚠️  Skipping rendering for "${entity.name}" (ID: ${entity.id}) due to previous status: ${entity.status}.`));
      renderSummary.skippedRender++;
      // Generate a more informative placeholder file for skipped/errored entities
      outputFiles.set(entity.unifiedPath, 
        `// ❌ Fusion Engine: This file was skipped from merge or had critical errors in previous steps.\n` +
        `// Status: ${entity.status}\n` +
        `// Original paths: ${entity.originalPaths.join(', ')}\n` +
        `// Review the full report for details: ${entity.id}\n`
      );
      continue;
    }

    try {
      // Generate code from the merged AST
      const { code: generatedCode, map: sourceMap } = generate(entity.mergedAST, {
        retainFunctionParens: true,
        retainLines: false, // Allows generator to reformat
        compact: false,
        concise: false,
        sourceMaps: true, // Generate source maps conceptually
        sourceFileName: path.basename(entity.unifiedPath), // Name for the source map
        // sourceRoot: path.dirname(entity.unifiedPath), // Optional: Root for source maps
        generatorOpts: {
          jsescOption: { minimal: true },
          indent: { style: '  ', base: 0, adjustComments: true },
        },
      });

      outputFiles.set(entity.unifiedPath, generatedCode);
      renderSummary.successfullyRendered++;
      renderSummary.totalLinesOfCodeRendered += generatedCode.split('\n').length;
      console.log(chalk.green(`    ✔ Rendered "${entity.name}" to ${entity.unifiedPath}. LOC: ${generatedCode.split('\n').length}`));

      if (entity.status === 'merged-with-warnings' || entity.needsManualReview) {
          renderSummary.entitiesWithRenderWarnings.push(entity.id);
          console.warn(chalk.yellow(`      ⚠️  Rendered with warnings/needs review.`));
      }
      // Conceptual: Calculate LOC added/removed if original LOC was tracked more precisely
      // if (entity.mergedFromCount > 1 && entity.originalPaths.length > 0) {
      //     const maxOriginalLoc = Math.max(...entity.originalPaths.map(p => originalAnalyzedFileMap.get(p)?.loc || 0));
      //     renderSummary.totalCodeAddedLoc += Math.max(0, entity.loc - maxOriginalLoc);
      // }

    } catch (error: any) {
      console.error(chalk.red.bold(`    ❌ Failed to render "${entity.name}" (ID: ${entity.id}). Error: ${error.message}`));
      console.error(chalk.red(error.stack || ''));
      renderSummary.failedToRender++;
      renderSummary.entitiesWithRenderWarnings.push(entity.id); // Mark as warning due to render failure
      // Generate a comprehensive error placeholder file
      outputFiles.set(entity.unifiedPath, 
        `// ❌ Fusion Engine: CRITICAL RENDERING ERROR for "${entity.name}"\n` +
        `// ID: ${entity.id}\n` +
        `// Error: ${error.message}\n` +
        `// Stack: ${error.stack || 'N/A'}\n` +
        `// Original paths: ${entity.originalPaths.join(', ')}\n` +
        `// This file might be corrupted or unrenderable. Manual intervention required.\n`
      );
    }
  }

  const renderEndTime = Date.now();
  renderSummary.totalRenderDurationMs = renderEndTime - renderStartTime;
  renderSummary.averageRenderTimePerEntityMs = renderSummary.totalEntitiesToRender > 0 
      ? renderSummary.totalRenderDurationMs / renderSummary.totalEntitiesToRender 
      : 0;

  // --- Post-Render Validation ---
  console.log(chalk.yellow('\n─── Running Post-Render Validations (Conceptual) ───'));
  // This is where you would integrate tools like ESLint or TypeScript compiler
  // to validate the *rendered* code strings for correctness.
  try {
      renderSummary.postRenderLintStatus = await runPostRenderLint(input.finalMergedEntities);
      if (renderSummary.postRenderLintStatus === 'passed') {
          console.log(chalk.green('    ✔ Post-render linting passed.'));
      } else if (renderSummary.postRenderLintStatus === 'failed') {
          console.error(chalk.red('    ❌ Post-render linting failed. Review linting reports.'));
          renderSummary.entitiesWithRenderWarnings.push('POST_RENDER_LINT_FAILURE'); // Add a general flag
      } else {
          console.log(chalk.gray(`    Post-render linting status: ${renderSummary.postRenderLintStatus}.`));
      }

      renderSummary.postRenderTypeCheckStatus = await runPostRenderTypeCheck(input.finalMergedEntities);
      if (renderSummary.postRenderTypeCheckStatus === 'passed') {
          console.log(chalk.green('    ✔ Post-render type checking passed.'));
      } else if (renderSummary.postRenderTypeCheckStatus === 'failed') {
          console.error(chalk.red('    ❌ Post-render type checking failed. Review type check reports.'));
          renderSummary.entitiesWithRenderWarnings.push('POST_RENDER_TYPE_CHECK_FAILURE'); // Add a general flag
      } else {
          console.log(chalk.gray(`    Post-render type checking status: ${renderSummary.postRenderTypeCheckStatus}.`));
      }
  } catch (validationError: any) {
      console.error(chalk.red(`    ❌ Error during post-render validation phase: ${validationError.message}`));
      // Set status based on actual validation results
      renderSummary.postRenderLintStatus = 'failed';
      renderSummary.postRenderTypeCheckStatus = 'failed';
      renderSummary.entitiesWithRenderWarnings.push('POST_RENDER_VALIDATION_ERROR');
  }


  // --- Final Summary Display ---
  logBoxedMessage('Render Step Summary', chalk.blue);
  console.log(chalk.bold(`  Total Entities Attempted to Render: ${renderSummary.totalEntitiesToRender}`));
  console.log(chalk.bold(`  Successfully Rendered: ${renderSummary.successfullyRendered}`));
  console.log(chalk.bold(`  Skipped (Prev Issues): ${renderSummary.skippedRender}`));
  console.log(chalk.bold(`  Failed During Rendering: `) + chalk.red.bold(renderSummary.failedToRender.toString()));
  console.log(chalk.bold(`  Total Lines of Code Rendered: ${renderSummary.totalLinesOfCodeRendered}`));
  console.log(chalk.bold(`  Total Render Duration: ${renderSummary.totalRenderDurationMs} ms`));
  console.log(chalk.bold(`  Average Render Time per Entity: ${renderSummary.averageRenderTimePerEntityMs?.toFixed(2)} ms`));
  if (renderSummary.entitiesWithRenderWarnings.length > 0) {
      console.warn(chalk.yellow(`  ⚠️  Entities Rendered with Warnings/Errors: ${renderSummary.entitiesWithRenderWarnings.length} (IDs: ${renderSummary.entitiesWithRenderWarnings.slice(0, 5).join(', ')}${renderSummary.entitiesWithRenderWarnings.length > 5 ? '...' : ''})`));
  }
  console.log(chalk.bold(`  Post-Render Lint Status: ${renderSummary.postRenderLintStatus}`));
  console.log(chalk.bold(`  Post-Render Type Check Status: ${renderSummary.postRenderTypeCheckStatus}`));
  // console.log(chalk.bold(`  Total Code Added LOC (Conceptual): ${renderSummary.totalCodeAddedLoc || 0}`)); // Enable if implemented

  if (renderSummary.failedToRender > 0 || renderSummary.skippedRender > 0 || renderSummary.entitiesWithRenderWarnings.length > 0) {
      console.warn(chalk.yellow(`\n  Review the render report for details on skipped, failed, or warned entities.`));
      // Final overall status based on render results
      if (renderSummary.failedToRender > 0) {
          console.error(chalk.red.bold('❌ Render Step completed with CRITICAL ERRORS!'));
      } else {
          console.warn(chalk.yellow.bold('⚠️ Render Step completed with WARNINGS.'));
      }
  } else {
      console.log(chalk.green('\n  🎉 All entities rendered successfully! Final code ready to write.'));
  }
  logBoxedMessage('Render Step completed successfully.', chalk.green);

  return { outputFiles, renderSummary };
}
