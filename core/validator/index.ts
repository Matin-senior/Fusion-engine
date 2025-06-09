// fusion-engine/core/validator/index.ts
import chalk from 'chalk';
import path from 'path'; // ✅ اضافه شد: برای استفاده از path.resolve
export * from './interfaces';
// Import all validator functions
import { runSelfTest } from './selfTest';
import { scanProjectFilesForValidation } from './projectScanner';
import { checkDependencies } from './dependencyChecker';
import { checkImports } from './importValidator';

// Import interfaces
import { ValidationIssue, ValidationReport, SimpleScannedFile } from './interfaces';

/**
 * Orchestrates the entire validation process for Fusion Engine.
 * It runs a series of checks including self-test, file scanning,
 * dependency validation, and import validation.
 * Provides a comprehensive report with a clear overall status.
 *
 * @param projectPaths An array of absolute or relative paths to the project directories to validate.
 * @returns A promise that resolves to a ValidationReport object.
 */
export async function runValidation(projectPaths: string[]): Promise<ValidationReport> {
  console.log(chalk.magenta('\n╔═══════════════════════════════════════════════════════════════════╗'));
  console.log(chalk.magenta('║        🚀 Starting Fusion Engine Pre-Flight Validation Checks        ║'));
  console.log(chalk.magenta('╚═══════════════════════════════════════════════════════════════════╝'));

  const report: ValidationReport = {
    overallStatus: 'passed',
    issues: [],
    summary: {
      totalProjectsValidated: projectPaths.length,
      totalFilesScanned: 0,
      criticalErrors: 0,
      warnings: 0,
      passedChecks: 0,
    },
  };

  try {
    // --- Phase 1: Self-Test (Exits process if critical issues are found) ---
    // selfTest will call process.exit(1) on critical errors, so no need to catch here.
    runSelfTest(); 
    report.summary.passedChecks++;
    console.log(chalk.green('✔ Initial self-test passed.'));

    // --- Phase 2: Project File Scanning (Lightweight for validation) ---
    console.log(chalk.yellow('\n─── Scanning project files for validation ───'));
    const scannedFiles: SimpleScannedFile[] = scanProjectFilesForValidation(projectPaths);
    report.summary.totalFilesPassed = scannedFiles.length; // Corrected property name for clarity
    report.summary.totalFilesScanned = scannedFiles.length; // Still need total files scanned for summary
    console.log(chalk.green(`✔ Scanned ${scannedFiles.length} files.`));
    report.summary.passedChecks++;

    // Extract absolute root paths for other validators
    const absoluteProjectRoots = projectPaths.map(p => path.resolve(process.cwd(), p));

    // --- Phase 3: Dependency Validation (Package.json conflicts) ---
    console.log(chalk.yellow('\n─── Checking project dependencies for conflicts ───'));
    const dependencyIssues = await checkDependencies(scannedFiles, absoluteProjectRoots);
    report.issues.push(...dependencyIssues);
    report.summary.passedChecks++;

    // --- Phase 4: Import Validation (Unresolved imports) ---
    console.log(chalk.yellow('\n─── Validating import paths in code files ───'));
    const importIssues = await checkImports(scannedFiles, absoluteProjectRoots);
    report.issues.push(...importIssues);
    report.summary.passedChecks++;

  } catch (globalError: any) {
    // Catch any unexpected errors from validation phases that didn't exit the process
    report.overallStatus = 'failed';
    report.issues.push({
      type: 'error',
      message: `An unhandled error occurred during validation: ${globalError.message}`,
      details: globalError.stack || 'No stack trace available.',
    });
    console.error(chalk.red.bold(`\n❌ CRITICAL UNHANDLED ERROR: ${globalError.message}`));
    console.error(chalk.red(globalError.stack || ''));
  }

  // --- Final Report Compilation ---
  report.summary.criticalErrors = report.issues.filter(issue => issue.type === 'error').length;
  report.summary.warnings = report.issues.filter(issue => issue.type === 'warning').length;

  if (report.summary.criticalErrors > 0) {
    report.overallStatus = 'failed';
  } else if (report.summary.warnings > 0) {
    report.overallStatus = 'warnings';
  } else {
    report.overallStatus = 'passed';
  }

  // --- Display Final Report ---
  console.log(chalk.magenta('\n╔═══════════════════════════════════════════════════════════════════╗'));
  console.log(chalk.magenta('║               ✨ Fusion Engine Validation Report ✨                ║'));
  console.log(chalk.magenta('╚═══════════════════════════════════════════════════════════════════╝'));

  console.log(chalk.bold(`\nOverall Status: `) + getStatusColor(report.overallStatus)(report.overallStatus.toUpperCase()));
  console.log(chalk.bold(`Total Projects Validated: ${report.summary.totalProjectsValidated}`));
  console.log(chalk.bold(`Total Files Scanned: ${report.summary.totalFilesScanned}`));
  console.log(chalk.bold(`Checks Passed: ${report.summary.passedChecks}`));
  console.log(chalk.bold(`Critical Errors: `) + chalk.red.bold(report.summary.criticalErrors.toString()));
  console.log(chalk.bold(`Warnings: `) + chalk.yellow.bold(report.summary.warnings.toString()));

  if (report.issues.length > 0) {
    console.log(chalk.bold('\n─── Detected Issues ───'));
    report.issues.forEach((issue, index) => {
      const icon = issue.type === 'error' ? chalk.red('❌') : chalk.yellow('⚠️');
      const headerColor = issue.type === 'error' ? chalk.red.bold : chalk.yellow.bold;
      console.log(`\n${icon} ${headerColor(`[${issue.type.toUpperCase()}] `)} ${chalk.bold(issue.message)}`);
      if (issue.filePath) {
        console.log(chalk.gray(`  File: ${issue.filePath}`));
      }
      if (issue.details) {
        console.log(chalk.gray(`  Details: ${issue.details}`));
      }
      if (issue.codeSnippet) {
        console.log(chalk.gray(`  Code: \n${chalk.white.bgBlack(issue.codeSnippet)}`)); // Black background for code snippet
      }
    });
  } else {
    console.log(chalk.green('\n🎉 No issues detected! Your projects are ready for fusion!'));
  }

  console.log(chalk.magenta('\n╚═══════════════════════════════════════════════════════════════════╝'));

  return report;
}

/** Helper function to get color based on status */
function getStatusColor(status: ValidationReport['overallStatus']) {
  if (status === 'passed') return chalk.green.bold;
  if (status === 'warnings') return chalk.yellow.bold;
  return chalk.red.bold;
}

// Example usage (for testing or CLI entry point)
// if (require.main === module) {
//   // Replace with actual project paths for testing
//   const testProjectPaths = ['./projects/my-react-app', './projects/another-react-app']; 
//   runValidation(testProjectPaths).then(report => {
//     // You can inspect the report object here if needed
//     // console.log(report);
//   }).catch(e => {
//     console.error(chalk.red.bold('Validation process failed unexpectedly:'), e);
//   });
// }
