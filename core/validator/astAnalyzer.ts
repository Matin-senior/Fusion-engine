// src/modules/analyzer/astAnalyzer.ts
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';

import * as parser from '@babel/parser';
import traverse, { Scope, NodePath } from '@babel/traverse'; // Import NodePath
import * as t from '@babel/types';

export { ScannedFile, ScannedProject } from '../../src/core/validator/projectScanner';

/**
 * Represents the extracted AST information and dependencies for a single file.
 */
export interface ASTDependency {
  file: ScannedFile;
  imports: { name: string; path: string; isRelative: boolean; importedAs?: string }[];
  exports: { name: string; type: 'function' | 'variable' | 'class' | 'component' | 'default' | 're-export' }[];
  functions: { name: string; isExported: boolean; isAsync: boolean }[];
  components: { name: string; isExported: boolean; isFunctional: boolean; isMemoized?: boolean; isForwardRef?: boolean; inferredHOC?: string }[]; // Added inferredHOC
  contextAPIs: { name: string; type: 'Provider' | 'Consumer' | 'Context' }[];
  declaredVariables: { name: string; kind: 'const' | 'let' | 'var'; isExported: boolean }[];
  jsxElementsUsed: { name: string; count: number }[];
  reactHooksUsed: { name: string; count: number }[];
  // Added meta information
  loc: number; // Lines of code
}

const REACT_HOOKS = ['useState', 'useEffect', 'useContext', 'useReducer', 'useCallback', 'useMemo', 'useRef', 'useImperativeHandle', 'useLayoutEffect', 'useDebugValue', 'useDeferredValue', 'useId', 'useInsertionEffect', 'useSyncExternalStore', 'useTransition'];

/** Dynamically determines Babel parser plugins based on file extension. */
function getBabelPlugins(extension: string): parser.ParserPlugin[] {
  const plugins: parser.ParserPlugin[] = [
    'jsx', 'classProperties', 'objectRestSpread', 'exportDefaultFrom',
    'exportNamespaceFrom', 'dynamicImport', 'optionalChaining',
    'nullishCoalescingOperator', 'decorators-legacy', 'estree', 'importAssertions',
    'privateMethods', 'classPrivateProperties', 'classPrivateMethods',
  ];

  if (extension === '.ts' || extension === '.tsx') {
    plugins.push('typescript');
  } else if (extension === '.flow' || extension === '.flow.js') {
    plugins.push('flow');
  }
  return plugins;
}

/**
 * Attempts to infer if a node is a React Component.
 * Now accepts NodePath for better context, handles nested HOCs, and robustly infers.
 */
function inferReactComponent(
  nodePath: NodePath<t.Node>, // Changed to NodePath for more context
  isExported: boolean
): ASTDependency['components'][number] | null {
  const node = nodePath.node; // Extract the node from NodePath
  const scope = nodePath.scope; // Extract scope

  let name: string | null = null;
  let isFunctional = false;
  let isMemoized = false;
  let isForwardRef = false;
  let inferredHOC: string | undefined; // To store Higher-Order Component name

  if (t.isFunctionDeclaration(node) && node.id) {
    name = node.id.name;
    isFunctional = true;
  } else if (t.isClassDeclaration(node) && node.id) {
    name = node.id.name;
    isFunctional = false;
  } else if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
    name = node.id.name;
    if (t.isArrowFunctionExpression(node.init) || t.isFunctionExpression(node.init)) {
      isFunctional = true;
    } else if (t.isCallExpression(node.init)) {
      // Handle nested HOCs like React.memo(forwardRef(MyComponent)) or withRouter(MyComponent)
      let currentCallee: t.Expression = node.init.callee;
      let currentArg: t.Expression | undefined = node.init.arguments?.[0];

      while (t.isCallExpression(currentArg)) { // Traverse inner call expressions
          if (t.isIdentifier(currentCallee)) inferredHOC = currentCallee.name; // Capture outer HOC
          if (t.isMemberExpression(currentCallee) && t.isIdentifier(currentCallee.property)) inferredHOC = currentCallee.property.name;

          currentCallee = currentArg.callee;
          currentArg = currentArg.arguments?.[0];
      }

      // Check the innermost function/component
      if (t.isIdentifier(currentArg)) { // e.g. the `MyComponent` in `withRouter(MyComponent)`
          const binding = scope.getBinding(currentArg.name);
          if (binding && (t.isFunctionDeclaration(binding.path.node) || t.isVariableDeclarator(binding.path.node) || t.isClassDeclaration(binding.path.node))) {
              const innerComponent = inferReactComponent(binding.path as NodePath<t.Node>, isExported); // Recursive call with correct path
              if (innerComponent) {
                  return { ...innerComponent, inferredHOC: inferredHOC || innerComponent.inferredHOC };
              }
          }
      }

      // Check React.memo and React.forwardRef directly
      if (t.isMemberExpression(node.init.callee) && t.isIdentifier(node.init.callee.object, { name: 'React' })) {
        if (t.isIdentifier(node.init.callee.property, { name: 'memo' })) isMemoized = true;
        if (t.isIdentifier(node.init.callee.property, { name: 'forwardRef' })) isForwardRef = true;
      }
    }
  } else if (t.isFunctionExpression(node) && node.id) {
      name = node.id.name;
      isFunctional = true;
  } else if (t.isArrowFunctionExpression(node)) {
    // For unnamed arrow functions used directly, e.g., in default exports
    name = nodePath.parentPath && t.isExportDefaultDeclaration(nodePath.parentPath.node) ? 'defaultExportComponent' : 'anonymousComponent';
    isFunctional = true;
  }

  if (!name || name === 'anonymousComponent' && !isExported) return null; // Don't track non-exported anonymous components

  const isPascalCase = /^[A-Z][a-zA-Z0-9]*$/.test(name);
  if (!isPascalCase && name !== 'default' && name !== 'defaultExportComponent') return null;

  let hasJSX = false;
  // Create a temporary program to traverse only the specific node's content for JSX
  const tempProgram = t.program([t.isStatement(node) ? node : t.expressionStatement(node)]);
  traverse(t.file(tempProgram), {
      JSXElement(path) { hasJSX = true; path.stop(); },
      JSXFragment(path) { hasJSX = true; path.stop(); },
      CallExpression(path) {
          if (t.isMemberExpression(path.node.callee) &&
              t.isIdentifier(path.node.callee.object, { name: 'React' }) &&
              t.isIdentifier(path.node.callee.property, { name: 'createElement' })) {
              hasJSX = true;
              path.stop();
          }
      }
  }, scope); // Pass scope for proper binding resolution

  if (hasJSX) {
    return { name, isExported, isFunctional, isMemoized, isForwardRef, inferredHOC };
  }
  return null;
}


/**
 * Analyzes a list of ScannedFile objects using Babel AST parser
 * to extract detailed import/export relationships, function/component definitions,
 * and other relevant structural information, with improved robustness and insights.
 */
export function analyzeFilesAST(files: ScannedFile[]): ASTDependency[] {
  console.log(chalk.blue('\n🧠 Starting Quantum AST Analysis: Deconstructing Code DNA with Ultimate Precision & Stability...'));
  const analyzedDependencies: ASTDependency[] = [];

  for (const file of files) {
    console.log(chalk.cyan(`  Parsing: ${file.relativePath}`));
    let code: string;
    try {
      code = fs.readFileSync(file.absolutePath, 'utf8');
    } catch (e: any) {
      console.warn(chalk.yellow(`    ⚠️  Failed to read file ${file.relativePath}. Skipping. Error: ${e.message}`));
      continue;
    }

    const fileImports: ASTDependency['imports'] = [];
    const fileExports: ASTDependency['exports'] = [];
    const fileFunctions: ASTDependency['functions'] = [];
    const fileComponents: ASTDependency['components'] = [];
    const fileContextAPIs: ASTDependency['contextAPIs'] = [];
    const fileDeclaredVariables: ASTDependency['declaredVariables'] = [];
    const jsxElementsUsed: { [name: string]: number } = {};
    const reactHooksUsed: { [name: string]: number } = {};
    const loc = code.split('\n').length; // Calculate Lines of Code (LOC)


    try {
      const ast = parser.parse(code, {
        sourceType: 'module',
        plugins: getBabelPlugins(file.extension),
        errorRecovery: true,
        fileName: file.absolutePath,
        codeFrame: true,
      });

      traverse(ast, {
        // --- Imports ---
        ImportDeclaration(path) {
          const importedPath = path.node.source.value;
          const isRelative = importedPath.startsWith('.') || importedPath.startsWith('/');
          path.node.specifiers.forEach(specifier => {
            if (t.isImportSpecifier(specifier)) {
              fileImports.push({
                name: t.isIdentifier(specifier.imported) ? specifier.imported.name : '',
                importedAs: specifier.local.name,
                path: importedPath,
                isRelative: isRelative,
              });
            } else if (t.isImportDefaultSpecifier(specifier)) {
                fileImports.push({ name: 'default', importedAs: specifier.local.name, path: importedPath, isRelative: isRelative });
            } else if (t.isImportNamespaceSpecifier(specifier)) {
                fileImports.push({ name: '*', importedAs: specifier.local.name, path: importedPath, isRelative: isRelative });
            }
          });
        },

        // --- Exports ---
        // Enhanced export detection
        ExportNamedDeclaration(path) {
            // Handle `export { something } from './other'` (Re-exports)
            if (path.node.source) {
                path.node.specifiers.forEach(spec => {
                    if (t.isExportSpecifier(spec)) {
                        fileExports.push({
                            name: t.isIdentifier(spec.exported) ? spec.exported.name : '',
                            type: 're-export',
                        });
                    }
                });
            } else if (path.node.declaration) { // Standard named exports (export const X = ..., export function Y() {})
                const declaration = path.node.declaration;
                let exportedName: string | null = null;
                let exportType: ASTDependency['exports'][number]['type'] = 'variable';

                if (t.isFunctionDeclaration(declaration) && declaration.id) {
                    exportedName = declaration.id.name; exportType = 'function';
                } else if (t.isClassDeclaration(declaration) && declaration.id) {
                    exportedName = declaration.id.name; exportType = 'class';
                } else if (t.isVariableDeclaration(declaration)) {
                    declaration.declarations.forEach(declarator => {
                        if (t.isIdentifier(declarator.id)) {
                            fileExports.push({ name: declarator.id.name, type: 'variable' });
                        }
                    });
                }

                if (exportedName && !fileExports.some(exp => exp.name === exportedName && exp.type === exportType)) {
                    fileExports.push({ name: exportedName, type: exportType });
                }

                // Check for components
                if (t.isFunctionDeclaration(declaration) || t.isClassDeclaration(declaration) || t.isVariableDeclaration(declaration)) {
                    if (t.isVariableDeclaration(declaration)) { // Handle each declarator in a variable declaration
                        declaration.declarations.forEach(declarator => {
                            const component = inferReactComponent(path.get('declaration').get('declarations')[declaration.declarations.indexOf(declarator)] as NodePath<t.Node>, true); // Pass correct NodePath
                            if (component && !fileComponents.some(c => c.name === component.name)) {
                                fileComponents.push(component);
                            }
                        });
                    } else { // Function or Class Declaration
                        const component = inferReactComponent(path.get('declaration') as NodePath<t.Node>, true);
                        if (component && !fileComponents.some(c => c.name === component.name)) {
                            fileComponents.push(component);
                        }
                    }
                }
            }
        },
        ExportDefaultDeclaration(path) {
            if (!fileExports.some(exp => exp.name === 'default' && exp.type === 'default')) {
                fileExports.push({ name: 'default', type: 'default' });
            }

            // Robustly infer component for default exports
            if (t.isIdentifier(path.node.declaration)) { // export default MyComponent;
                const binding = path.scope.getBinding(path.node.declaration.name);
                if (binding && binding.path && (t.isVariableDeclarator(binding.path.node) || t.isFunctionDeclaration(binding.path.node) || t.isClassDeclaration(binding.path.node))) {
                    const component = inferReactComponent(binding.path as NodePath<t.Node>, true);
                    if (component && !fileComponents.some(c => c.name === component.name)) {
                        fileComponents.push(component);
                    }
                }
            } else if (t.isFunctionDeclaration(path.node.declaration) || t.isFunctionExpression(path.node.declaration) || t.isArrowFunctionExpression(path.node.declaration)) {
                // Pass the correct NodePath for function/arrow function expressions
                const component = inferReactComponent(path.get('declaration') as NodePath<t.Node>, true);
                if (component && !fileComponents.some(c => c.name === component.name)) {
                    fileComponents.push(component);
                }
            } else if (t.isCallExpression(path.node.declaration)) { // e.g., export default memo(MyComponent)
                const component = inferReactComponent(path.get('declaration') as NodePath<t.Node>, true);
                if (component && !fileComponents.some(c => c.name === component.name)) {
                    fileComponents.push(component);
                }
            }
        },
        ExportAllDeclaration(path) {
            fileExports.push({ name: '*', type: 're-export' });
        },

        // --- Functions --- (Non-exported functions are also relevant)
        FunctionDeclaration(path) {
            if (path.node.id) {
                // Check if it's explicitly exported by a parent ExportNamedDeclaration
                const isExported = path.parentPath && t.isExportNamedDeclaration(path.parentPath.node);
                fileFunctions.push({ name: path.node.id.name, isExported: isExported || false, isAsync: path.node.async });
            }
        },
        VariableDeclarator(path) {
            if (t.isIdentifier(path.node.id)) {
                if (t.isArrowFunctionExpression(path.node.init) || t.isFunctionExpression(path.node.init)) {
                    // Check if it's explicitly exported by a parent ExportNamedDeclaration
                    const isExported = path.parentPath?.parentPath && t.isExportNamedDeclaration(path.parentPath.parentPath.node);
                    fileFunctions.push({ name: path.node.id.name, isExported: isExported || false, isAsync: path.node.init.async });
                }
            }
        },

        // --- Declared Variables ---
        VariableDeclaration(path) {
            const kind = path.node.kind;
            // A variable declaration is exported if its direct parent is an ExportNamedDeclaration
            const isExported = path.parentPath && t.isExportNamedDeclaration(path.parentPath.node);
            path.node.declarations.forEach(declarator => {
                if (t.isIdentifier(declarator.id)) {
                    if (!fileDeclaredVariables.some(v => v.name === declarator.id.name)) {
                        fileDeclaredVariables.push({ name: declarator.id.name, kind, isExported: isExported || false });
                    }
                }
            });
        },

        // --- JSX Element Usage ---
        JSXOpeningElement(path) {
            const tagName = t.isJSXIdentifier(path.node.name) ? path.node.name.name : '';
            if (tagName && /^[A-Z]/.test(tagName)) { // Ensure it's a PascalCase component, not HTML
                jsxElementsUsed[tagName] = (jsxElementsUsed[tagName] || 0) + 1;
            }
        },

        // --- React Hooks Usage ---
        CallExpression(path) {
            if (t.isIdentifier(path.node.callee) && REACT_HOOKS.includes(path.node.callee.name)) {
                const hookName = path.node.callee.name;
                reactHooksUsed[hookName] = (reactHooksUsed[hookName] || 0) + 1;
            } else if (t.isMemberExpression(path.node.callee) &&
                       t.isIdentifier(path.node.callee.object) &&
                       t.isIdentifier(path.node.callee.property)) {
                const objectName = path.node.callee.object.name;
                const propertyName = path.node.callee.property.name;
                const binding = path.scope.getBinding(objectName);
                if (binding && t.isImportNamespaceSpecifier(binding.path.node) && REACT_HOOKS.includes(propertyName)) {
                    reactHooksUsed[propertyName] = (reactHooksUsed[propertyName] || 0) + 1;
                }
            }
        },

        // --- Context API Detection --- (Refined for Named Context Exports)
        // This catches both `const MyContext = React.createContext();` and `export const MyContext = React.createContext();`
        VariableDeclarator(path) {
            if (
                t.isIdentifier(path.node.id) &&
                t.isCallExpression(path.node.init) &&
                t.isMemberExpression(path.node.init.callee) &&
                t.isIdentifier(path.node.init.callee.object, { name: 'React' }) &&
                t.isIdentifier(path.node.init.callee.property, { name: 'createContext' })
            ) {
                fileContextAPIs.push({ name: path.node.id.name, type: 'Context' });
            }
        },
        MemberExpression(path) {
            if (t.isIdentifier(path.node.property, { name: 'Provider' })) {
                const contextName = t.isIdentifier(path.node.object) ? path.node.object.name : null;
                if (contextName) fileContextAPIs.push({ name: contextName, type: 'Provider' });
            } else if (t.isIdentifier(path.node.property, { name: 'Consumer' })) {
                const contextName = t.isIdentifier(path.node.object) ? path.node.object.name : null;
                if (contextName) fileContextAPIs.push({ name: contextName, type: 'Consumer' });
            }
        },
      });
    } catch (error: any) {
      console.warn(chalk.red.bold(`    ❌ CRITICAL PARSING ERROR for ${file.relativePath}:\n${error.message}`));
      if (error.codeFrame) {
        console.warn(chalk.red(error.codeFrame));
      }
      continue;
    }

    analyzedDependencies.push({
      file: file,
      imports: fileImports,
      exports: fileExports,
      functions: fileFunctions,
      components: fileComponents.filter((c, i, a) => a.findIndex(t => t.name === c.name) === i),
      contextAPIs: fileContextAPIs.filter((c, i, a) => a.findIndex(t => t.name === c.name && t.type === c.type) === i),
      declaredVariables: fileDeclaredVariables.filter((v, i, a) => a.findIndex(t => t.name === v.name) === i),
      jsxElementsUsed: Object.entries(jsxElementsUsed).map(([name, count]) => ({ name, count })),
      reactHooksUsed: Object.entries(reactHooksUsed).map(([name, count]) => ({ name, count })),
      loc: loc, // Add lines of code
    });
  }

  console.log(chalk.blue('✅ Quantum AST Analysis completed. Deep insights extracted with ultimate precision & stability!\n'));
  return analyzedDependencies;
}