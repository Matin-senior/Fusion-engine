// src/modules/analyzer/workspaceAnalyzer.ts
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';

// Import ScannedFile and ASTDependency interfaces and the analyzer function
import { ScannedFile, ASTDependency, analyzeFilesAST } from './astAnalyzer';
// Re-export ASTDependency for external use if needed
export { ASTDependency };

/**
 * Represents the comprehensive analysis result for a single code file.
 * Keyed by relative file path for easy lookup.
 */
export type AnalyzedFileMap = {
  [relativePath: string]: Omit<ASTDependency, 'file'>;
};

/**
 * Represents the complete analysis of a single project within the workspace.
 */
export interface AnalyzedProject {
  name: string;
  rootPath: string;
  analyzedFiles: AnalyzedFileMap;
  totalFilesScanned: number;
  totalLinesOfCode: number;
  parsingErrors: string[]; // List of relative file paths that failed AST parsing
  // Add more aggregated data from ASTDependency for project-level insights
  totalComponents: number;
  totalFunctions: number;
  totalHooks: number;
}

// Optimized exclusion list for directories to speed up scanning
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.vscode', '.next', '.parcel-cache', 'dist', 'build', 'out', 'coverage',
  'temp', '.cache', 'logs', // Common build/temp/log directories
]);
const ALLOWED_CODE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

/**
 * Recursively walks a directory, collecting relevant code files and their paths.
 * Robustly handles read permissions and symlinks.
 * @param currentDirPath The current directory to walk.
 * @param projectRootPath The root path of the project being scanned.
 * @returns An array of ScannedFile objects representing detected code files.
 */
function collectCodeFiles(currentDirPath: string, projectRootPath: string): ScannedFile[] {
  const collectedFiles: ScannedFile[] = [];
  let entries: fs.Dirent[];

  try {
    entries = fs.readdirSync(currentDirPath, { withFileTypes: true });
  } catch (error: any) {
    // Handle permission errors or other read issues
    console.warn(chalk.red(`    ❌ Access Denied: Could not read directory "${currentDirPath}". Skipping. Error: ${error.message}`));
    return [];
  }

  for (const entry of entries) {
    const entryPath = path.join(currentDirPath, entry.name);
    const relativeEntryPath = path.relative(projectRootPath, entryPath);

    // Skip symlinks to prevent infinite loops or redundant scans in linked directories
    if (entry.isSymbolicLink()) {
      // console.log(chalk.gray(`      Skipping symlink: ${entryPath}`)); // Optional: for debugging symlink skips
      continue;
    }

    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) {
        continue; // Skip explicitly excluded directories
      }
      collectedFiles.push(...collectCodeFiles(entryPath, projectRootPath)); // Recurse
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (ALLOWED_CODE_EXTENSIONS.has(ext)) {
        try {
          const stats = fs.statSync(entryPath);
          const sizeKB = parseFloat((stats.size / 1024).toFixed(2));
          collectedFiles.push({
            absolutePath: entryPath,
            relativePath: relativeEntryPath,
            extension: ext,
            fileName: entry.name,
            baseName: path.basename(entry.name, ext),
            sizeKB: sizeKB,
            // Inferred roles/framework specifics are added during AST analysis or initial project scan
            // This scanner's job is just to find the files
          });
        } catch (fileStatError: any) {
          console.warn(chalk.red(`    ❌ Failed to get file stats for "${entryPath}". Skipping. Error: ${fileStatError.message}`));
        }
      }
    }
  }
  return collectedFiles;
}

/**
 * Analyzes one or more project directories within the workspace.
 * It robustly finds all relevant code files, processes them through the AST analyzer,
 * and aggregates the results into a structured and comprehensive format.
 *
 * @param projectPaths An array of absolute or relative paths to the project directories.
 * @returns A promise resolving to an array of AnalyzedProject objects, each containing comprehensive analysis.
 */
export async function analyzeWorkspace(projectPaths: string[]): Promise<AnalyzedProject[]> {
  console.log(chalk.magenta('\n✨ Starting Workspace Analysis: Unveiling the Full Codebase Blueprint with Resilience...'));
  const allAnalyzedProjects: AnalyzedProject[] = [];

  for (const projectPath of projectPaths) {
    const absoluteProjectPath = path.resolve(process.cwd(), projectPath);
    const projectName = path.basename(absoluteProjectPath);

    console.log(chalk.yellow(`\n  📂 Processing project: ${projectName} (${absoluteProjectPath})`));

    // Robust project path validation
    try {
        const stats = fs.statSync(absoluteProjectPath);
        if (!stats.isDirectory()) {
            console.warn(chalk.red.bold(`    ❌ Error: Project path "${projectPath}" exists but is not a directory. Skipping analysis for this project.`));
            continue;
        }
    } catch (error: any) {
        console.warn(chalk.red.bold(`    ❌ Error: Project path "${projectPath}" not found or inaccessible. Skipping analysis for this project. Error: ${error.message}`));
        continue;
    }


    const projectFilesToAnalyze = collectCodeFiles(absoluteProjectPath, absoluteProjectPath);
    console.log(chalk.gray(`    Found ${projectFilesToAnalyze.length} potential code files to analyze.`));

    if (projectFilesToAnalyze.length === 0) {
      console.warn(chalk.yellow(`    ⚠️  No relevant code files found in "${projectName}". Skipping AST analysis.`));
      allAnalyzedProjects.push({
        name: projectName, rootPath: absoluteProjectPath, analyzedFiles: {},
        totalFilesScanned: 0, totalLinesOfCode: 0, parsingErrors: [],
        totalComponents: 0, totalFunctions: 0, totalHooks: 0,
      });
      continue;
    }

    // Call the powerful analyzeFilesAST from the previous step
    const astAnalysisResults = analyzeFilesAST(projectFilesToAnalyze);

    const analyzedFileMap: AnalyzedFileMap = {};
    let totalLinesOfCode = 0;
    const parsingErrors: string[] = [];
    let totalComponents = 0;
    let totalFunctions = 0;
    let totalHooks = 0;

    for (const result of astAnalysisResults) {
      if (result.imports || result.exports || result.components.length > 0 || result.functions.length > 0) {
        // If analysis was successful (even partial), store it
        const { file, ...rest } = result;
        analyzedFileMap[file.relativePath] = rest;
        totalLinesOfCode += result.loc || 0; // Ensure LOC is added, default to 0 if not present
        totalComponents += result.components.length;
        totalFunctions += result.functions.length;
        // totalHooks += Object.values(result.reactHooksUsed).reduce((sum, count) => sum + count, 0); // Sum all hook counts
        totalHooks += Object.values(result.reactHooksUsed).reduce((sum, hookUsage) => sum + hookUsage.count, 0);
      } else {
        // If no data was extracted, assume a parsing error
        parsingErrors.push(result.file.relativePath);
      }
    }

    // Comprehensive logging and error summary
    console.log(chalk.green(`  ✅ Analysis complete for "${projectName}".`));
    console.log(chalk.green(`    Processed Files: ${Object.keys(analyzedFileMap).length} / ${projectFilesToAnalyze.length}`));
    console.log(chalk.green(`    Total Lines of Code: ${totalLinesOfCode}`));
    console.log(chalk.green(`    Detected Components: ${totalComponents}`));
    console.log(chalk.green(`    Detected Functions: ${totalFunctions}`));
    console.log(chalk.green(`    Detected Hooks Calls: ${totalHooks}`));
    if (parsingErrors.length > 0) {
      console.error(chalk.red.bold(`    ❌ Critical AST parsing errors in ${parsingErrors.length} files. Review logs for details. `));
    }
    // Optional: Log names of problematic files
    // if (parsingErrors.length > 0) {
    //     console.error(chalk.red.bold(`      Problematic files: ${parsingErrors.join(', ')}`));
    // }


    allAnalyzedProjects.push({
      name: projectName,
      rootPath: absoluteProjectPath,
      analyzedFiles: analyzedFileMap,
      totalFilesScanned: projectFilesToAnalyze.length,
      totalLinesOfCode: totalLinesOfCode,
      parsingErrors: parsingErrors,
      totalComponents: totalComponents,
      totalFunctions: totalFunctions,
      totalHooks: totalHooks,
    });
  }

  console.log(chalk.magenta('\n🎉 Workspace Analysis Complete! The entire codebase blueprint is robustly captured.\n'));
  return allAnalyzedProjects;
}