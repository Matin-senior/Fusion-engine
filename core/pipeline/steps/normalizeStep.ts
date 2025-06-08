// fusion-engine/core/pipeline/steps/normalizeStep.ts
import chalk from 'chalk';
import path from 'path';
import fs from 'fs'; // To read file content for normalization

// Import Babel AST tools
import * as parser from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import generate from '@babel/generator'; // To generate code from AST

// Import types from modules/analyzer
import { AnalyzedProject, ASTDependency } from '../../../modules/analyzer/workspaceAnalyzer';
// ✅ اینترفیس InternalDependencyMap حالا باید از resolveAndMergeStep به درستی export شده باشد
import { MergedComponent, MergedHook, MergedUtility, MergedContext, ResolveAndMergeStepOutput, InternalDependencyMap } from './resolveAndMergeStep'; 

// --- Input & Output Interfaces for Normalize Step ---

export type NormalizationInput = {
  analyzedWorkspaces: AnalyzedProject[]; // From ScanStep, has original ASTs
  mergedEntities: ResolveAndMergeStepOutput['mergedEntities']; // From ResolveAndMergeStep
  internalMap: InternalDependencyMap; // From ResolveAndMergeStep
};

/** Base interface for any normalized entity. */
export interface NormalizedEntityBase {
  id: string; // Unique ID (same as merged ID)
  name: string;
  unifiedPath: string; // The proposed new relative path
  normalizedCode: string; // The standardized code content
}

/** Defines a normalized component. */
export interface NormalizedComponent extends NormalizedEntityBase {
  type: 'functional' | 'class';
}

/** Defines a normalized hook. */
export interface NormalizedHook extends NormalizedEntityBase {}

/** Defines a normalized utility. */
export interface NormalizedUtility extends NormalizedEntityBase {}

/** Defines a normalized context. */
export interface NormalizedContext extends NormalizedEntityBase {
  contextType: 'Provider' | 'Consumer' | 'Context';
}

export type NormalizationOutput = {
  normalizedEntities: {
    components: NormalizedComponent[];
    hooks: NormalizedHook[];
    utilities: NormalizedUtility[];
    contexts: NormalizedContext[];
  };
  // Potentially add a summary of normalization changes
  normalizationSummary: {
    totalEntitiesNormalized: number;
    filesSkippedNormalization: string[]; // Files that couldn't be normalized (e.g., parsing errors)
    totalCodeChanged: number; // Count of files where normalization actually modified code
    changesReport: { [changeType: string]: number }; // e.g., {'imports_sorted': 10, 'comments_cleaned': 5}
  };
};

// --- Helper for consistent console logging with borders ---
function logBoxedMessage(message: string, color: typeof chalk): void {
  const line = '═'.repeat(message.length + 4);
  console.log(color(`╔${line}╗`));
  console.log(color(`║${' '.repeat(Math.floor(line.length / 2) - Math.floor(message.length / 2))}${message}${' '.repeat(Math.ceil(line.length / 2) - Math.ceil(message.length / 2))}║`)); // ✅ Fixed: Precise centering
  console.log(color(`╚${line}╝`));
}

/** Dynamically determines Babel parser plugins based on file extension (re-used from astAnalyzer). */
function getBabelPlugins(extension: string): parser.ParserPlugin[] {
    const plugins: parser.ParserPlugin[] = [
      'jsx', 'classProperties', 'objectRestSpread', 'exportDefaultFrom',
      'exportNamespaceFrom', 'dynamicImport', 'optionalChaining',
      'nullishCoalescingOperator', 'decorators-legacy', 'estree', 'importAssertions',
      // ✅ حذف شد: این پلاگین‌ها باعث خطا می‌شوند و معمولاً توسط 'classProperties' یا 'typescript' پوشش داده می‌شوند.
      // 'privateMethods', 'classPrivateProperties', 'classStaticBlock', 
    ];
    if (extension === '.ts' || extension === '.tsx') {
      plugins.push('typescript');
    } else if (extension === '.flow' || extension === '.flow.js') {
      plugins.push('flow');
    }
    return plugins;
}


// --- AST Normalization Helpers with Change Tracking ---

/** Defines report for changes made during normalization of a single file. */
interface FileNormalizationReport {
    changed: boolean;
    changesMade: string[]; // e.g., ['imports_sorted', 'comments_cleaned']
    error?: boolean; // Added for reporting errors in normalizeCode
}

/**
 * Sorts imports alphabetically by source path, then by imported name.
 * Tracks if changes were made.
 */
function sortImports(ast: t.File): { ast: t.File; changed: boolean } {
  let changed = false;
  const originalBody = JSON.stringify(ast.program.body.filter(node => t.isImportDeclaration(node))); // Capture original state

  traverse(ast, {
    Program(path) {
      const importDeclarations = path.node.body.filter(node => t.isImportDeclaration(node));
      const nonImportDeclarations = path.node.body.filter(node => !t.isImportDeclaration(node));

      const sortedImports = [...importDeclarations].sort((a, b) => {
        if (t.isImportDeclaration(a) && t.isImportDeclaration(b)) {
          if (a.source.value < b.source.value) return -1;
          if (a.source.value > b.source.value) return 1;

          // ✅ Fixed: Ensure specifiers[0].imported is an Identifier before accessing .name
          const nameA = a.specifiers[0] && t.isImportSpecifier(a.specifiers[0]) && t.isIdentifier(a.specifiers[0].imported) ? a.specifiers[0].imported.name : '';
          const nameB = b.specifiers[0] && t.isImportSpecifier(b.specifiers[0]) && t.isIdentifier(b.specifiers[0].imported) ? b.specifiers[0].imported.name : '';
          
          if (nameA < nameB) return -1;
          if (nameA > nameB) return 1;
          return 0;
        }
        return 0; // Don't sort non-import declarations
      });

      // Reconstruct body with sorted imports at the top
      const newBody = [...sortedImports, ...nonImportDeclarations];
      if (JSON.stringify(newBody.filter(node => t.isImportDeclaration(node))) !== originalBody) {
          path.node.body = newBody;
          changed = true;
      }
    }
  });
  return { ast, changed };
}

/**
 * Removes comments that are not JSDoc or special directives (e.g., pure block comments).
 * Tracks if changes were made.
 */
function cleanComments(ast: t.File): { ast: t.File; changed: boolean } {
    let changed = false;
    traverse(ast, {
        enter(path) {
            if (path.node.leadingComments) {
                const filtered = path.node.leadingComments.filter(comment => {
                    if (comment.type === 'CommentBlock' && comment.value.startsWith('*')) return true; // JSDoc
                    if (comment.value.includes('#__PURE__') || comment.value.includes('@ts-ignore') || comment.value.includes('@license')) return true; // Directives/Licenses
                    return false;
                });
                if (filtered.length !== path.node.leadingComments.length) {
                    path.node.leadingComments = filtered;
                    changed = true;
                }
            }
            if (path.node.trailingComments) {
                const filtered = path.node.trailingComments.filter(comment => {
                    if (comment.type === 'CommentBlock' && comment.value.startsWith('*')) return true;
                    if (comment.value.includes('#__PURE__') || comment.value.includes('@ts-ignore') || comment.value.includes('@license')) return true;
                    return false;
                });
                if (filtered.length !== path.node.trailingComments.length) {
                    path.node.trailingComments = filtered;
                    changed = true;
                }
            }
        }
    });
    return { ast, changed };
}

/**
 * Normalizes JSX attributes (e.g., sorts them alphabetically, removes unnecessary ones).
 * Tracks if changes were made.
 */
function normalizeJSXAttributes(ast: t.File): { ast: t.File; changed: boolean } {
    let changed = false;
    traverse(ast, {
        JSXOpeningElement(path) {
            const originalAttributes = JSON.stringify(path.node.attributes); // Capture original state

            // Sort attributes alphabetically
            path.node.attributes.sort((a, b) => {
                if (t.isJSXAttribute(a) && t.isJSXAttribute(b)) {
                    const nameA = t.isJSXIdentifier(a.name) ? a.name.name : '';
                    const nameB = t.isJSXIdentifier(b.name) ? b.name.name : '';
                    if (nameA < nameB) return -1;
                    if (nameA > nameB) return 1;
                }
                return 0;
            });

            // Remove boolean `true` attributes (e.g., `<Button disabled={true}/>` to `<Button disabled/>`)
            path.node.attributes = path.node.attributes.filter(attr => {
                if (t.isJSXAttribute(attr) && t.isJSXExpressionContainer(attr.value) && t.isBooleanLiteral(attr.value.expression, { value: true })) {
                    changed = true; // A change will occur here
                    return false; // Remove {true} attribute
                }
                return true;
            });

            if (JSON.stringify(path.node.attributes) !== originalAttributes) {
                changed = true;
            }
        }
    });
    return { ast, changed };
}

/**
 * Normalizes the order of properties in object literals and component props (conceptual).
 * This is a more advanced normalization that often requires careful scope analysis.
 * For now, just a placeholder.
 */
function normalizePropsOrder(ast: t.File): { ast: t.File; changed: boolean } {
    let changed = false;
    // TODO: Implement sorting of object properties or component props based on configuration.
    // This is significantly more complex as it requires differentiating between props and local variables
    // and potentially accessing component definitions.
    return { ast, changed };
}

/**
 * Main normalization function for a single file's code.
 * Parses, transforms AST, and generates normalized code.
 * @param code The source code string.
 * @param fileData The ScannedFile object for context.
 * @returns The normalized code string and a report of changes made.
 */
function normalizeCode(code: string, fileData: { absolutePath: string; extension: string; hasTypeScript?: boolean }): { normalizedCode: string; report: FileNormalizationReport } {
  const report: FileNormalizationReport = { changed: false, changesMade: [] };
  let ast: t.File;

  try {
    ast = parser.parse(code, {
      sourceType: 'module',
      plugins: getBabelPlugins(fileData.extension),
      errorRecovery: true,
    });

    // Apply transformations and track changes
    const importsResult = sortImports(ast);
    if (importsResult.changed) { ast = importsResult.ast; report.changed = true; report.changesMade.push('imports_sorted'); }

    const commentsResult = cleanComments(ast);
    if (commentsResult.changed) { ast = commentsResult.ast; report.changed = true; report.changesMade.push('comments_cleaned'); }
    
    const jsxAttrsResult = normalizeJSXAttributes(ast);
    if (jsxAttrsResult.changed) { ast = jsxAttrsResult.ast; report.changed = true; report.changesMade.push('jsx_attributes_normalized'); }

    // Placeholder for more complex normalizations
    const propsOrderResult = normalizePropsOrder(ast); // Example
    if (propsOrderResult.changed) { ast = propsOrderResult.ast; report.changed = true; report.changesMade.push('props_order_normalized'); }


    const { code: normalizedCode } = generate(ast, { 
        retainFunctionParens: true, 
        retainLines: false, // Disables retaining original line breaks, allowing generator to format
        compact: false,     // Ensures no compact output
        concise: false,     // Ensures no single-line output if possible
        // Optional: specify source map options if needed for debugging normalized code
        // sourceMaps: true,
        // sourceFileName: fileData.absolutePath,
        // sourceRoot: path.dirname(fileData.absolutePath),
        generatorOpts: {
            jsescOption: { minimal: true }, // Ensure minimal escaping (e.g. no unnecessary unicode escapes)
            retainFunctionParens: true, // Keep parens around arrow functions
            // Ensure consistent indentation (default to 2 spaces)
            indent: {
                style: '  ', // 2 spaces
                base: 0,
                adjustComments: true
            },
        }
    }); 

    // Final check: if generated code is identical to original, no real change
    if (normalizedCode === code) {
        report.changed = false;
        report.changesMade = [];
    }

    return { normalizedCode, report };

  } catch (error: any) {
    console.warn(chalk.red(`    ❌ Failed to normalize AST for ${fileData.absolutePath}. Error: ${error.message}`));
    if (error.codeFrame) {
      console.warn(chalk.red(error.codeFrame));
    }
    // Return original code if normalization fails, but report it
    return { normalizedCode: code, report: { changed: false, changesMade: [], error: true } };
  }
}


// --- Main Normalize Step Function ---
/**
 * The Normalize Step in the Fusion Engine pipeline.
 * It takes the analyzed and resolved entities, and standardizes their internal code structure
 * (e.g., sorting imports, cleaning comments, normalizing JSX attributes) to prepare them for merging.
 *
 * @param input The input object from the ResolveAndMerge Step.
 * @returns A promise that resolves to the NormalizationOutput.
 */
export async function runNormalizeStep(input: NormalizationInput): Promise<NormalizationOutput> {
  logBoxedMessage('⚙️ Pipeline Step: Normalize Entities (Standardization)', chalk.blue);

  const normalizedComponents: NormalizedComponent[] = [];
  const normalizedHooks: NormalizedHook[] = [];
  const normalizedUtilities: NormalizedUtility[] = [];
  const normalizedContexts: NormalizedContext[] = [];

  const normalizationSummary = {
    totalEntitiesNormalized: 0,
    filesSkippedNormalization: [] as string[],
    totalCodeChanged: 0, // How many entities' code actually changed
    changesReport: {} as { [changeType: string]: number }, // Detailed count of each type of change
  };

  // Create a map from original relative path to its ASTDependency for easy lookup
  const originalAnalyzedFileMap = new Map<string, ASTDependency>();
  input.analyzedWorkspaces.forEach(ws => {
      Object.entries(ws.analyzedFiles).forEach(([relPath, astDep]) => {
          originalAnalyzedFileMap.set(relPath, astDep);
      });
  });


  // Helper to process and normalize a single entity type
  const processAndNormalizeEntityType = <T extends MergedComponent | MergedHook | MergedUtility | MergedContext>(
    entities: T[],
    normalizedList: (NormalizedComponent | NormalizedHook | NormalizedUtility | NormalizedContext)[]
  ) => {
    for (const entity of entities) {
      const canonicalPath = entity.originalPaths[0]; // Pick the first original path as canonical source
      const originalFileAnalysis = originalAnalyzedFileMap.get(canonicalPath);

      if (!originalFileAnalysis) {
        console.warn(chalk.yellow(`    ⚠️  Original analysis for ${entity.name} (${canonicalPath}) not found. Skipping normalization.`));
        normalizationSummary.filesSkippedNormalization.push(canonicalPath);
        continue;
      }

      try {
        const originalCode = fs.readFileSync(originalFileAnalysis.file.absolutePath, 'utf8');
        // Pass originalFileAnalysis.file to normalizeCode for detailed context
        const { normalizedCode, report: fileNormReport } = normalizeCode(originalCode, originalFileAnalysis.file);

        const baseNormalizedProps = {
          id: entity.id,
          name: entity.name,
          unifiedPath: entity.unifiedPath,
          normalizedCode: normalizedCode,
        };

        if (entity.hasOwnProperty('type') && (entity as MergedComponent).type) { // It's a MergedComponent
          normalizedList.push({ ...baseNormalizedProps, type: (entity as MergedComponent).type } as NormalizedComponent);
        } else if (entity.hasOwnProperty('reactHooksUsed')) { // It's a MergedHook
          normalizedList.push({ ...baseNormalizedProps } as NormalizedHook);
        } else if (entity.hasOwnProperty('contextType')) { // It's a MergedContext
          normalizedList.push({ ...baseNormalizedProps, contextType: (entity as MergedContext).contextType } as NormalizedContext);
        } else { // It's a MergedUtility
          normalizedList.push({ ...baseNormalizedProps } as NormalizedUtility);
        }
        
        // Update summary based on file normalization report
        normalizationSummary.totalEntitiesNormalized++;
        if (fileNormReport.changed) {
            normalizationSummary.totalCodeChanged++;
            fileNormReport.changesMade.forEach(changeType => {
                normalizationSummary.changesReport[changeType] = (normalizationSummary.changesReport[changeType] || 0) + 1;
            });
        }
        if ((fileNormReport as any).error) { // If normalizeCode returned an error flag
            normalizationSummary.filesSkippedNormalization.push(canonicalPath);
            console.warn(chalk.yellow(`    ⚠️  Normalization had errors for ${entity.name}. Original code retained.`));
        } else {
            console.log(chalk.green(`    ✔ Normalized ${entity.name} (${entity.unifiedPath}) - ${fileNormReport.changed ? 'Changed' : 'No changes'}`));
        }


      } catch (error: any) {
        console.error(chalk.red.bold(`    ❌ Critical error processing ${entity.name} (${canonicalPath}). Error: ${error.message}`));
        normalizationSummary.filesSkippedNormalization.push(canonicalPath);
      }
    }
  };


  // 1. Normalize Components
  console.log(chalk.cyan(`  Normalizing components...`));
  processAndNormalizeEntityType(input.mergedEntities.components, normalizedComponents);
  console.log(chalk.green(`  Processed ${normalizedComponents.length} components.`));

  // 2. Normalize Hooks
  console.log(chalk.cyan(`  Normalizing hooks...`));
  processAndNormalizeEntityType(input.mergedEntities.hooks, normalizedHooks);
  console.log(chalk.green(`  Processed ${normalizedHooks.length} hooks.`));

  // 3. Normalize Contexts
  console.log(chalk.cyan(`  Normalizing contexts...`));
  processAndNormalizeEntityType(input.mergedEntities.contexts, normalizedContexts);
  console.log(chalk.green(`  Processed ${normalizedContexts.length} contexts.`));

  // 4. Normalize Utilities
  console.log(chalk.cyan(`  Normalizing utilities...`));
  processAndNormalizeEntityType(input.mergedEntities.utilities, normalizedUtilities);
  console.log(chalk.green(`  Processed ${normalizedUtilities.length} utilities.`));


  // Final Summary
  logBoxedMessage('Normalization Step Summary', chalk.blue);
  console.log(chalk.bold(`  Total Entities Processed: ${normalizationSummary.totalEntitiesNormalized}`));
  console.log(chalk.bold(`  Code Changed in ${normalizationSummary.totalCodeChanged} entities.`));
  
  if (Object.keys(normalizationSummary.changesReport).length > 0) {
      console.log(chalk.bold(`  Specific Changes Made:`));
      for (const [changeType, count] of Object.entries(normalizationSummary.changesReport)) {
          console.log(chalk.gray(`    - ${changeType.replace(/_/g, ' ')}: ${count} entities`));
      }
  }

  if (normalizationSummary.filesSkippedNormalization.length > 0) {
      console.warn(chalk.yellow(`  ⚠️  Files skipped due to errors: ${normalizationSummary.filesSkippedNormalization.length}`));
      normalizationSummary.filesSkippedNormalization.forEach(p => console.warn(chalk.red(`    - ${p}`)));
  } else {
      console.log(chalk.green(`  🎉 All entities normalized successfully!`));
  }
  logBoxedMessage('Normalization Step completed successfully.', chalk.green);


  return {
    normalizedEntities: {
      components: normalizedComponents,
      hooks: normalizedHooks,
      utilities: normalizedUtilities,
      contexts: normalizedContexts,
    },
    normalizationSummary: normalizationSummary,
  };
}
