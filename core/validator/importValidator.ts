// fusion-engine/core/validator/importValidator.ts
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types'; // For Babel AST types

// Import interfaces
import { SimpleScannedFile, ValidationIssue } from './interfaces';

// Common file extensions to try for resolution, ordered by commonality
const COMMON_RESOLVABLE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.json', // Code and data
  '.css', '.scss', '.less',             // Styles
  '.png', '.jpg', '.jpeg', '.gif', '.svg', // Images (often imported directly)
];

/**
 * Helper to resolve an import source path to a valid file path within the scanned project files.
 * This is a lightweight resolver specifically for the validator phase, not a full module resolver.
 * It handles relative paths, basic absolute paths, and basic tsconfig.json aliases.
 *
 * @param fromFilePath The absolute path of the file making the import.
 * @param importSource The raw import string (e.g., './Button', 'react', '@/utils/helpers').
 * @param allProjectFiles A list of all SimpleScannedFile objects in the project.
 * @param projectRootPath The absolute root path of the current project.
 * @param tsConfigPaths Optional: Parsed 'paths' from tsconfig.json for alias resolution.
 * @returns The SimpleScannedFile object if resolved, or null.
 */
function resolveImportPathForValidation(
  fromFilePath: string,
  importSource: string,
  allProjectFiles: SimpleScannedFile[],
  projectRootPath: string,
  tsConfigPaths?: Record<string, string[]>
): SimpleScannedFile | null {
  const fromDir = path.dirname(fromFilePath);

  // 1. Handle bare specifiers (npm packages, Node.js built-ins)
  // These are not resolved against project files in this validator.
  if (!importSource.startsWith('.') && !importSource.startsWith('/') && !importSource.startsWith('@')) {
    return null;
  }

  const possibleAbsolutePaths: string[] = [];

  // 2. Try TSConfig paths aliases first (e.g., '@components/Button' -> 'src/components/Button')
  if (tsConfigPaths) {
    for (const aliasPattern in tsConfigPaths) {
      if (aliasPattern.endsWith('/*')) { // Handle patterns like "@components/*"
        const aliasPrefix = aliasPattern.slice(0, -1); // Remove the "*"
        const actualPath = tsConfigPaths[aliasPattern][0].slice(0, -1); // Remove the "*" from the target path

        if (importSource.startsWith(aliasPrefix)) {
          const resolvedAliasPart = importSource.substring(aliasPrefix.length);
          possibleAbsolutePaths.push(path.resolve(projectRootPath, actualPath + resolvedAliasPart));
        }
      } else if (importSource === aliasPattern) { // Handle exact aliases like "@config"
        possibleAbsolutePaths.push(path.resolve(projectRootPath, tsConfigPaths[aliasPattern][0]));
      }
    }
  }

  // 3. Handle relative imports (e.g., './components/Button')
  if (importSource.startsWith('.')) {
    possibleAbsolutePaths.push(path.resolve(fromDir, importSource));
  }
  // 4. Handle absolute project-root imports (e.g., '/components/Button' or 'src/components/Button')
  else if (importSource.startsWith('/')) {
    possibleAbsolutePaths.push(path.resolve(projectRootPath, importSource.substring(1))); // from root
    possibleAbsolutePaths.push(path.resolve(projectRootPath, 'src', importSource.substring(1))); // common with src/
  }
  // 5. Handle potential non-aliased project-internal absolute paths (e.g., 'components/Button' if no src)
  else {
      possibleAbsolutePaths.push(path.resolve(projectRootPath, importSource));
      possibleAbsolutePaths.push(path.resolve(projectRootPath, 'src', importSource));
  }


  // Now, iterate through all possible absolute paths and try to match with known files
  for (const absPath of possibleAbsolutePaths) {
    // Try exact file match first
    const foundFile = allProjectFiles.find(file => file.absolutePath === absPath);
    if (foundFile) return foundFile;

    // Try appending common extensions and checking for index files
    for (const ext of COMMON_RESOLVABLE_EXTENSIONS) {
      const tryPathWithExt = absPath.endsWith(ext) ? absPath : `${absPath}${ext}`;
      const foundFileWithExt = allProjectFiles.find(file => file.absolutePath === tryPathWithExt);
      if (foundFileWithExt) return foundFileWithExt;

      const tryIndexPath = path.join(absPath, `index${ext}`);
      const foundIndexFile = allProjectFiles.find(file => file.absolutePath === tryIndexPath);
      if (foundIndexFile) return foundIndexFile;
    }
  }

  return null; // Resolution failed
}

/**
 * Extracts TSConfig 'paths' aliases from a tsconfig.json file.
 * @param filePath Absolute path to tsconfig.json.
 * @returns Parsed 'paths' object or undefined if not found/parseable.
 */
function getTsConfigPaths(filePath: string): Record<string, string[]> | undefined {
    try {
        const tsConfigContent = fs.readFileSync(filePath, 'utf8');
        const tsConfig = JSON.parse(tsConfigContent);
        // Assuming compilerOptions and paths exist
        return tsConfig.compilerOptions?.paths;
    } catch (e) {
        console.warn(chalk.yellow(`      ⚠️  Could not parse tsconfig.json at ${filePath} for aliases.`));
        return undefined;
    }
}

/**
 * Validates import statements in code files for resolution issues.
 * This validator uses a lightweight AST parser to check import paths against scanned project files.
 * It supports static and dynamic imports and basic tsconfig.json 'paths' aliases.
 *
 * @param scannedFiles A list of SimpleScannedFile objects from the projectScanner, including package.json and tsconfig.json.
 * @param projectRoots A list of absolute project root paths.
 * @returns A promise that resolves to an array of ValidationIssue objects.
 */
export async function checkImports(
    scannedFiles: SimpleScannedFile[],
    projectRoots: string[]
): Promise<ValidationIssue[]> {
    console.log(chalk.blue('\n🔗 Running Import Validator: Checking Code Connections...'));
    const issues: ValidationIssue[] = [];

    const codeFiles = scannedFiles.filter(file => ['.ts', '.tsx', '.js', '.jsx'].includes(file.extension));
    const tsConfigFiles = scannedFiles.filter(file => file.fileName === 'tsconfig.json');

    const projectTsConfigPaths = new Map<string, Record<string, string[]>>(); // rootPath -> tsConfigPaths

    for (const tsConfigFile of tsConfigFiles) {
        const root = projectRoots.find(r => tsConfigFile.absolutePath.startsWith(r));
        if (root) {
            const paths = getTsConfigPaths(tsConfigFile.absolutePath);
            if (paths) {
                projectTsConfigPaths.set(root, paths);
            }
        }
    }

    if (codeFiles.length === 0) {
        console.warn(chalk.yellow('    ⚠️  No code files found for import validation.'));
        return issues;
    }

    for (const file of codeFiles) {
        let fileContent: string;
        try {
            fileContent = fs.readFileSync(file.absolutePath, 'utf8');
        } catch (e: any) {
            issues.push({
                type: 'error',
                message: `Failed to read file content for import validation: ${file.relativePath}`,
                details: `Error: ${e.message}`,
                filePath: file.relativePath,
            });
            continue;
        }

        const projectRoot = projectRoots.find(r => file.absolutePath.startsWith(r)) || '';
        const tsConfigPaths = projectRoot ? projectTsConfigPaths.get(projectRoot) : undefined;

        try {
            const ast = parser.parse(fileContent, {
                sourceType: 'module',
                // Plugins are critical for correct parsing of JS/TS/JSX
                plugins: [
                    'jsx',
                    file.extension === '.ts' || file.extension === '.tsx' ? 'typescript' : 'flow', // Use flow for .js files if ts is not needed
                    'dynamicImport', // For import() syntax
                    'classProperties', 'objectRestSpread', 'optionalChaining', 'nullishCoalescingOperator' // Common modern JS features
                ],
                errorRecovery: true, // Crucial for robustness when parsing potentially malformed code
            });

            traverse(ast, {
                ImportDeclaration(path) {
                    const importSource = path.node.source.value;
                    const resolvedFile = resolveImportPathForValidation(
                        file.absolutePath,
                        importSource,
                        scannedFiles, // Pass all scanned files for resolution
                        projectRoot,
                        tsConfigPaths
                    );

                    if (!resolvedFile) {
                        issues.push({
                            type: 'error',
                            message: `Unresolved import path: "${importSource}"`,
                            details: `The static import module "${importSource}" could not be resolved to a file in the project. This can lead to build failures.`,
                            filePath: file.relativePath,
                            codeSnippet: fileContent.substring(path.node.start!, path.node.end!), // Show the exact import line
                        });
                        console.error(chalk.red(`    ❌ Unresolved import in ${file.relativePath}: "${importSource}"`));
                    }
                },
                CallExpression(path) {
                    // Detect dynamic imports: import('module')
                    if (t.isImport(path.node.callee)) {
                        const importArgument = path.node.arguments[0];
                        if (t.isStringLiteral(importArgument)) {
                            const importSource = importArgument.value;
                            const resolvedFile = resolveImportPathForValidation(
                                file.absolutePath,
                                importSource,
                                scannedFiles,
                                projectRoot,
                                tsConfigPaths
                            );
                            if (!resolvedFile) {
                                issues.push({
                                    type: 'error',
                                    message: `Unresolved dynamic import path: "${importSource}"`,
                                    details: `The dynamically imported module "${importSource}" could not be resolved. This can lead to runtime errors.`,
                                    filePath: file.relativePath,
                                    codeSnippet: fileContent.substring(path.node.start!, path.node.end!),
                                });
                                console.error(chalk.red(`    ❌ Unresolved dynamic import in ${file.relativePath}: "${importSource}"`));
                            }
                        }
                    }
                }
            });

        } catch (error: any) {
            issues.push({
                type: 'error',
                message: `Failed to parse file for import validation: ${file.relativePath}`,
                details: `Error: ${error.message}. This might indicate a syntax error or misconfiguration.`,
                filePath: file.relativePath,
                codeSnippet: error.codeFrame || fileContent.substring(0, Math.min(fileContent.length, 200)) + '...', // Show code frame if available, else first 200 chars
            });
            console.error(chalk.red(`    ❌ Parsing error in ${file.relativePath} for import validation.`));
            if (error.codeFrame) {
                console.error(chalk.red(error.codeFrame));
            }
        }
    }

    console.log(chalk.blue('✅ Import Validator completed.'));
    return issues;
}
