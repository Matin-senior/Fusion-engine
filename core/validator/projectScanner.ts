// fusion-engine/core/validator/projectScanner.ts
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';

// Import SimpleScannedFile interface from the new interfaces file
import { SimpleScannedFile } from './interfaces'; 

// Optimized exclusion list for directories to speed up scanning
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.vscode', '.next', '.parcel-cache', 'dist', 'build', 'out', 'coverage',
  'temp', '.cache', 'logs', // Common build/temp/log directories
]);
const RELEVANT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.json', '.yaml', '.yml', // Code & Config files
  '.css', '.scss', '.less', '.html', '.htm', // Style & HTML files
]);

/**
 * Scans a list of project directories to collect basic file information for validation purposes.
 * This function is simpler and faster than the analyzer's projectScanner, focusing only on file paths.
 *
 * @param projectPaths An array of absolute or relative paths to the project directories.
 * @returns An array of SimpleScannedFile objects containing basic information for relevant files.
 */
export function scanProjectFilesForValidation(projectPaths: string[]): SimpleScannedFile[] {
  console.log(chalk.blue('\n🔍 Running quick file scan for validation...'));
  const allScannedFiles: SimpleScannedFile[] = [];

  for (const projectPath of projectPaths) {
    const absoluteProjectPath = path.resolve(process.cwd(), projectPath);
    const projectName = path.basename(absoluteProjectPath);

    console.log(chalk.cyan(`  Scanning for validation in: ${projectName} (${absoluteProjectPath})`));

    // Validate project path existence and type
    try {
      const stats = fs.statSync(absoluteProjectPath);
      if (!stats.isDirectory()) {
        console.warn(chalk.red.bold(`    ❌ Error: Project path "${projectPath}" exists but is not a directory. Skipping validation scan for this path.`));
        continue;
      }
    } catch (error: any) {
      console.warn(chalk.red.bold(`    ❌ Error: Project path "${projectPath}" not found or inaccessible. Skipping validation scan for this path. Error: ${error.message}`));
      continue;
    }

    /**
     * Recursively walks a directory, collecting paths of files with relevant extensions.
     * @param currentDirPath The current directory to walk.
     * @param projectRootPath The root path of the project being scanned.
     */
    function walkDir(currentDirPath: string, projectRootPath: string) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDirPath, { withFileTypes: true });
      } catch (error: any) {
        console.warn(chalk.red(`    ❌ Access Denied: Could not read directory "${currentDirPath}". Skipping. Error: ${error.message}`));
        return; // Stop processing this directory
      }

      for (const entry of entries) {
        const entryPath = path.join(currentDirPath, entry.name);
        const relativeEntryPath = path.relative(projectRootPath, entryPath);

        if (entry.isSymbolicLink()) {
          continue; // Skip symlinks
        }

        if (entry.isDirectory()) {
          if (EXCLUDE_DIRS.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) {
            continue; // Skip excluded directories and hidden directories
          }
          walkDir(entryPath, projectRootPath); // Recurse
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (RELEVANT_EXTENSIONS.has(ext)) {
            allScannedFiles.push({
              absolutePath: entryPath,
              relativePath: relativeEntryPath,
              fileName: entry.name,
              extension: ext,
            });
          }
        }
      }
    }

    walkDir(absoluteProjectPath, absoluteProjectPath);
  }

  console.log(chalk.blue(`✅ Quick file scan completed. Found ${allScannedFiles.length} files for validation.\n`));
  return allScannedFiles;
}
