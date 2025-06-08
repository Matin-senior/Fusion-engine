// fusion-engine/core/pipeline/steps/scanStep.ts
import chalk from 'chalk';
import path from 'path'; 
import fs from 'fs'; // ✅ اضافه شد: برای استفاده از fs.statSync

// Correct import path for AnalyzedProject (from workspaceAnalyzer.ts)
import { AnalyzedProject, analyzeWorkspace } from '../../../modules/analyzer/workspaceAnalyzer'; 

/**
 * Defines the input for the Scan Step.
 */
export type ScanStepInput = {
  sourceProjects: string[]; // Absolute or relative paths to the input project directories.
};

/**
 * Defines the output of the Scan Step.
 */
export type ScanStepOutput = {
  analyzedWorkspaces: AnalyzedProject[]; // The result of the comprehensive workspace analysis.
  scanSummary: {
    totalInputProjects: number;
    successfullyAnalyzed: number;
    failedToAnalyze: string[]; // List of project paths that failed analysis within this step
    totalFilesProcessed: number;
    totalLinesOfCode: number;
  };
};

/**
 * The first step in the Fusion Engine pipeline.
 * It takes raw project paths, triggers the comprehensive workspace analysis,
 * and prepares the detailed analysis results for subsequent pipeline steps.
 * This version includes enhanced logging, input validation, and result summary.
 *
 * @param input The input object containing source project paths.
 * @returns A promise that resolves to the ScanStepOutput with analyzed project data.
 */
export async function runScanStep(input: ScanStepInput): Promise<ScanStepOutput> {
  console.log(chalk.blue('\n╔═══════════════════════════════════════════════════════════════════╗'));
  console.log(chalk.blue('║                   ⚙️ Pipeline Step: Scan Projects                   ║'));
  console.log(chalk.blue('╚═══════════════════════════════════════════════════════════════════╝'));

  const scanSummary = {
    totalInputProjects: input.sourceProjects.length,
    successfullyAnalyzed: 0,
    failedToAnalyze: [] as string[],
    totalFilesProcessed: 0,
    totalLinesOfCode: 0,
  };

  // --- Input Validation ---
  if (!input.sourceProjects || input.sourceProjects.length === 0) {
    console.error(chalk.red.bold('❌ ERROR: Scan step received no source project paths.'));
    throw new Error('No source projects provided for scanning.');
  }

  // Pre-validate project paths for existence and directory type
  const validProjectPaths: string[] = [];
  console.log(chalk.cyan(`  Validating ${input.sourceProjects.length} input project path(s)...`));
  for (const projectPath of input.sourceProjects) {
    const absolutePath = path.resolve(process.cwd(), projectPath);
    try {
      const stats = fs.statSync(absolutePath);
      if (!stats.isDirectory()) {
        console.warn(chalk.red(`    ❌ Path "${projectPath}" is not a directory. Skipping.`));
        scanSummary.failedToAnalyze.push(projectPath);
      } else {
        validProjectPaths.push(projectPath);
        console.log(chalk.gray(`    ✔ Path "${projectPath}" is valid.`));
      }
    } catch (error: any) {
      console.warn(chalk.red(`    ❌ Path "${projectPath}" not found or inaccessible. Skipping. Error: ${error.message}`));
      scanSummary.failedToAnalyze.push(projectPath);
    }
  }

  if (validProjectPaths.length === 0) {
    console.error(chalk.red.bold('❌ ERROR: No valid project paths found after initial validation. Aborting scan.'));
    throw new Error('No valid source projects to scan.');
  }

  console.log(chalk.cyan(`  Initiating deep analysis for ${validProjectPaths.length} valid project(s)...`));
  validProjectPaths.forEach(p => console.log(chalk.gray(`    - ${p}`)));

  let analyzedWorkspaces: AnalyzedProject[] = [];
  try {
    // Call the powerful analyzeWorkspace function to get the full codebase blueprint
    analyzedWorkspaces = await analyzeWorkspace(validProjectPaths);

    // Aggregate summary from analyzed workspaces
    scanSummary.successfullyAnalyzed = analyzedWorkspaces.length;
    analyzedWorkspaces.forEach(proj => {
      scanSummary.totalFilesProcessed += proj.totalFilesScanned;
      scanSummary.totalLinesOfCode += proj.totalLinesOfCode;
      if (proj.parsingErrors.length > 0) {
          scanSummary.failedToAnalyze.push(...proj.parsingErrors.map(errPath => `${proj.name}/${errPath}`)); // Add files with parsing errors
      }
    });

    if (analyzedWorkspaces.length === 0) {
      console.warn(chalk.yellow('    ⚠️  No valid projects were deeply analyzed. Check input paths and project contents.'));
    } else {
      console.log(chalk.green(`  ✅ Successfully analyzed ${analyzedWorkspaces.length} project(s).`));
    }

    return { analyzedWorkspaces, scanSummary };

  } catch (error: any) {
    console.error(chalk.red.bold(`\n❌ CRITICAL ERROR during Scan Step: ${error.message}`));
    console.error(chalk.red(error.stack || ''));
    throw new Error(`Scan Step failed: ${error.message}`);
  } finally {
    // --- Final Summary Display ---
    console.log(chalk.blue('\n╔═══════════════════════════════════════════════════════════════════╗'));
    console.log(chalk.blue('║                Scan Step Summary & Next Actions                     ║'));
    console.log(chalk.blue('╚═══════════════════════════════════════════════════════════════════╝'));
    console.log(chalk.bold(`  Total Input Projects: ${scanSummary.totalInputProjects}`));
    console.log(chalk.bold(`  Valid Projects for Analysis: ${validProjectPaths.length}`));
    console.log(chalk.bold(`  Successfully Analyzed Projects: ${scanSummary.successfullyAnalyzed}`));
    console.log(chalk.bold(`  Total Files Processed: ${scanSummary.totalFilesProcessed}`));
    console.log(chalk.bold(`  Total Lines of Code: ${scanSummary.totalLinesOfCode}`));

    if (scanSummary.failedToAnalyze.length > 0) {
      console.error(chalk.red.bold(`\n  ❌ Projects/Files with Issues: ${scanSummary.failedToAnalyze.length}`));
      scanSummary.failedToAnalyze.forEach(p => console.error(chalk.red(`    - ${p}`)));
      console.log(chalk.yellow(`  Review the issues above and logs for details.`));
    } else {
      console.log(chalk.green(`\n  🎉 All projects processed successfully with no critical issues!`));
    }
    console.log(chalk.blue('╚═══════════════════════════════════════════════════════════════════╝'));
  }
}
