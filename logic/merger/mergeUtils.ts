// fusion-engine/logic/merger/mergeUtils.ts
import * as t from '@babel/types';
import * as parser from '@babel/parser'; // Ensure parser is imported
import generate from '@babel/generator'; // Ensure generator is imported

/**
 * Helper to get Babel parser plugins based on file extension.
 * Re-using this from astAnalyzer/normalizeStep for consistency.
 */
function getBabelPlugins(extension: string): parser.ParserPlugin[] {
    const plugins: parser.ParserPlugin[] = [
      'jsx', 'classProperties', 'objectRestSpread', 'exportDefaultFrom',
      'exportNamespaceFrom', 'dynamicImport', 'optionalChaining',
      'nullishCoalescingOperator', 'decorators-legacy', 'estree', 'importAssertions',
    ];
    if (extension === '.ts' || extension === '.tsx') {
      plugins.push('typescript');
    } else if (extension === '.flow' || extension === '.flow.js') {
      plugins.push('flow');
    }
    return plugins;
}

/**
 * Parses code into an AST. Includes error recovery.
 * @param code The source code string.
 * @param filePath For error reporting context.
 * @param fileExtension For Babel plugins.
 * @returns The parsed AST.
 */
export function parseCodeToAst(code: string, filePath: string, fileExtension: string): t.File {
    try {
        return parser.parse(code, {
            sourceType: 'module',
            plugins: getBabelPlugins(fileExtension),
            errorRecovery: true,
            // fileName: filePath, // This option might be in different versions of Babel parser
            // codeFrame: true,
        });
    } catch (error: any) {
        console.error(`Error parsing AST for ${filePath}: ${error.message}`);
        if (error.codeFrame) {
            console.error(error.codeFrame);
        }
        throw new Error(`Failed to parse AST for ${filePath}`);
    }
}

/**
 * Compares two ASTs for structural similarity at a basic level.
 * This is a highly simplified comparison. A true deep semantic comparison is very complex.
 * For now, checks equality of generated code.
 * @param ast1 First AST.
 * @param ast2 Second AST.
 * @returns True if considered structurally similar.
 */
export function compareAsts(ast1: t.File, ast2: t.File): boolean {
    // This is a very simplistic comparison - a real solution would involve deep AST traversal
    // and semantic comparison, potentially hashing node structures.
    // For now, if the generated code is identical, we consider them similar.
    // This assumes normalization has already made them syntactically consistent.
    const code1 = generate(ast1, { compact: true, concise: true }).code;
    const code2 = generate(ast2, { compact: true, concise: true }).code;
    return code1 === code2;
}

/**
 * Merges two ASTs. This is a conceptual function.
 * Actual merge logic depends heavily on conflict types and desired outcome.
 * For now, if there's no conflict, it simply returns the AST of the first entity.
 * If there are minor differences, it would contain logic to combine specific parts.
 *
 * @param baseAst The AST to merge into (e.g., from the canonical entity).
 * @param incomingAst The AST to merge from.
 * @returns The merged AST.
 */
export function mergeAsts(baseAst: t.File, incomingAst: t.File): t.File {
    // This is a placeholder for complex AST merging logic.
    // Real AST merging involves:
    // 1. Identifying common nodes.
    // 2. Identifying conflicting nodes.
    // 3. Applying merge strategies (e.g., "take ours", "take theirs", "combine").
    // 4. Re-writing import/export paths after merging.

    // For now, we'll return the baseAst, assuming normalization has handled most conflicts,
    // and critical conflicts prevent automatic merging.
    return baseAst;
}
