// fusion-engine/modules/analyzer/astAnalyzer.ts
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';

import * as parser from '@babel/parser';
import traverse, { Scope, NodePath } from '@babel/traverse';
import * as t from '@babel/types';

// Import ScannedFile from the same 'analyzer' module
import { ScannedFile } from './projectScanner'; 

// Re-export ScannedFile for consistency, if other modules use it from here
export { ScannedFile };

/**
 * Represents the extracted AST information and dependencies for a single file.
 */
export interface ASTDependency {
  file: ScannedFile; // The original scanned file metadata
  imports: { name: string; path: string; isRelative: boolean; importedAs?: string }[];
  exports: { name: string; type: 'function' | 'variable' | 'class' | 'component' | 'default' | 're-export' }[];
  functions: { name: string; isExported: boolean; isAsync: boolean }[];
  components: { name: string; isExported: boolean; isFunctional: boolean; isMemoized?: boolean; isForwardRef?: boolean; inferredHOC?: string }[];
  contextAPIs: { name: string; type: 'Provider' | 'Consumer' | 'Context' }[];
  declaredVariables: { name: string; kind: 'const' | 'let' | 'var'; isExported: boolean }[];
  jsxElementsUsed: { name: string; count: number }[];
  reactHooksUsed: { name: string; count: number }[];
  loc: number; // Lines of code

  // --- ADDED FOR TYPE DEPENDENCIES (Assumes they are extracted by AST analyzer) ---
  declaredTypes: { name: string; isExported: boolean; kind: 'interface' | 'typeAlias' | 'enum' }[]; // Types declared in this file
  typesUsedInAnnotations: { name: string; count: number }[]; // Types used in type annotations (e.g., `const x: MyType`)
}

const REACT_HOOKS = ['useState', 'useEffect', 'useContext', 'useReducer', 'useCallback', 'useMemo', 'useRef', 'useImperativeHandle', 'useLayoutEffect', 'useDebugValue', 'useDeferredValue', 'useId', 'useInsertionEffect', 'useSyncExternalStore', 'useTransition'];

/** Dynamically determines Babel parser plugins based on file extension. */
function getBabelPlugins(extension: string): parser.ParserPlugin[] {
  const plugins: parser.ParserPlugin[] = [
    'jsx', 'classProperties', 'objectRestSpread', 'exportDefaultFrom',
    'exportNamespaceFrom', 'dynamicImport', 'optionalChaining',
    'nullishCoalescingOperator', 'decorators-legacy', 'estree', 'importAssertions',
    // Removed specific private class features as they are usually covered by 'classProperties' or 'typescript' plugin
    // 'privateMethods', 'classPrivateProperties', 'classPrivateMethods',
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
      let currentCallee: t.Expression;
      // ✅ Ensure node.init.callee is an Expression before assigning
      if (t.isExpression(node.init.callee)) {
          currentCallee = node.init.callee;
      } else {
          return null; // Cannot proceed if callee is not a valid expression type
      }
      
      // ✅ Ensure currentArg is an Expression or undefined from the start
      let currentArg: t.Expression | undefined = t.isExpression(node.init.arguments?.[0]) ? node.init.arguments[0] : undefined;

      // ✅ Added t.isExpression(currentCallee) for type safety in while loop
      while (currentArg && t.isCallExpression(currentArg) && t.isExpression(currentCallee)) { 
          if (t.isIdentifier(currentCallee)) inferredHOC = currentCallee.name;
          if (t.isMemberExpression(currentCallee) && t.isIdentifier(currentCallee.property)) inferredHOC = currentCallee.property.name;

          // ✅ Ensure currentArg.callee is an Expression before reassigning currentCallee
          if (t.isExpression(currentArg.callee)) {
              currentCallee = currentArg.callee;
          } else {
              break; // Break loop if callee is not a valid expression type
          }
          // ✅ Ensure the next argument is an Expression before assigning to currentArg
          currentArg = t.isExpression(currentArg.arguments?.[0]) ? currentArg.arguments[0] : undefined;
      }

      // Ensure currentCallee is still an Expression before proceeding
      if (t.isExpression(currentCallee)) { 
          // Check the innermost function/component
          if (currentArg && t.isIdentifier(currentArg)) { 
              const binding = scope.getBinding(currentArg.name);
              if (binding && (t.isFunctionDeclaration(binding.path.node) || t.isVariableDeclarator(binding.path.node) || t.isClassDeclaration(binding.path.node))) {
                  const innerNodePath = binding.path as NodePath<t.FunctionDeclaration | t.VariableDeclarator | t.ClassDeclaration>;
                  const inferred = inferReactComponent(innerNodePath, isExported);
                  if (inferred) return { ...inferred, inferredHOC: inferredHOC || inferred.inferredHOC };
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
    name = nodePath.parentPath && t.isExportDefaultDeclaration(nodePath.parentPath.node) ? 'defaultExportComponent' : 'anonymousComponent';
    isFunctional = true;
  }


  if (!name || (name === 'anonymousComponent' && !isExported)) return null;

  const isPascalCase = /^[A-Z][a-zA-Z0-9]*$/.test(name);
  if (!isPascalCase && name !== 'default' && name !== 'defaultExportComponent') return null;

  let hasJSX = false;
  let tempNode: t.Statement | t.ExpressionStatement | null = null;
  if (t.isStatement(node)) {
    tempNode = node;
  } else if (t.isExpression(node)) {
    tempNode = t.expressionStatement(node);
  }

  if (!tempNode) return null;

  traverse(t.file(t.program([tempNode])), {
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
  }, scope);

  if (hasJSX) {
    return { name, isExported, isFunctional, isMemoized, isForwardRef, inferredHOC };
  }
  return null;
}


/**
 * Analyzes a list of ScannedFile objects using Babel AST parser
 * to extract detailed import/export relationships, function/component definitions,
 * and other relevant structural information, with improved robustness.
 */
export function analyzeFilesAST(files: ScannedFile[]): ASTDependency[] {
  console.log(chalk.blue('\n🧠 Starting Quantum AST Analysis: Deconstructing Code DNA with Enhanced Precision...'));
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
    const declaredTypes: ASTDependency['declaredTypes'] = []; 
    const typesUsedInAnnotations: { [name: string]: number } = {}; 
    const loc = code.split('\n').length;


    try {
      const ast = parser.parse(code, {
        sourceType: 'module',
        plugins: getBabelPlugins(file.extension),
        errorRecovery: true,
        // Removed fileName and codeFrame as direct properties of this options object
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
        ExportNamedDeclaration(path) {
            path.node.specifiers.forEach(specifier => {
                fileExports.push({ name: t.isIdentifier(specifier.exported) ? specifier.exported.name : '', type: 'variable' });
            });
            if (path.node.declaration) {
                const declaration = path.node.declaration;
                if (t.isVariableDeclaration(declaration)) {
                    declaration.declarations.forEach(declarator => {
                        if (t.isIdentifier(declarator.id)) {
                            fileExports.push({ name: declarator.id.name, type: 'variable' });
                            const component = inferReactComponent(path.get('declaration').get('declarations')[declaration.declarations.indexOf(declarator)] as NodePath<t.Node>, true);
                            if (component) fileComponents.push(component);
                        }
                    });
                } else if (t.isFunctionDeclaration(declaration)) {
                    if (declaration.id) {
                        fileExports.push({ name: declaration.id.name, type: 'function' });
                        const component = inferReactComponent(path.get('declaration') as NodePath<t.Node>, true);
                        if (component) fileComponents.push(component);
                    }
                } else if (t.isClassDeclaration(declaration)) {
                    if (declaration.id) {
                        fileExports.push({ name: declaration.id.name, type: 'class' });
                        const component = inferReactComponent(path.get('declaration') as NodePath<t.Node>, true);
                        if (component) fileComponents.push(component);
                    }
                }
            }
        },
        ExportDefaultDeclaration(path) {
            fileExports.push({ name: 'default', type: 'default' });
            const declarationNode = path.node.declaration;
            if (t.isIdentifier(declarationNode)) {
                const binding = path.scope.getBinding(declarationNode.name);
                if (binding && binding.path && (t.isVariableDeclarator(binding.path.node) || t.isFunctionDeclaration(binding.path.node) || t.isClassDeclaration(binding.path.node))) {
                    const component = inferReactComponent(binding.path as NodePath<t.Node>, true);
                    if (component) fileComponents.push(component);
                }
            } else {
                const component = inferReactComponent(path.get('declaration') as NodePath<t.Node>, true);
                if (component) fileComponents.push(component);
            }
        },
        ExportAllDeclaration(path) {
            fileExports.push({ name: '*', type: 're-export' });
        },

        // --- Functions ---
        FunctionDeclaration(path) {
            if (path.node.id) {
                const isExported = t.isExportDeclaration(path.parentPath.node);
                fileFunctions.push({ name: path.node.id.name, isExported: isExported, isAsync: path.node.async });
            }
        },
        // --- Variables (including for functions and context creation) ---
        VariableDeclarator(path) {
            if (t.isIdentifier(path.node.id)) {
                // Check if it's an ArrowFunctionExpression or FunctionExpression (a function variable)
                if (t.isArrowFunctionExpression(path.node.init) || t.isFunctionExpression(path.node.init)) {
                    const isExported = t.isExportDeclaration(path.parentPath.node);
                    fileFunctions.push({ name: path.node.id.name, isExported: isExported, isAsync: path.node.init.async });
                }

                // Check for React.createContext()
                if (t.isCallExpression(path.node.init) &&
                    t.isMemberExpression(path.node.init.callee) &&
                    t.isIdentifier(path.node.init.callee.object, { name: 'React' }) &&
                    t.isIdentifier(path.node.init.callee.property, { name: 'createContext' })) {
                    fileContextAPIs.push({ name: path.node.id.name, type: 'Context' });
                }
            }
        },
        // --- Class Declarations ---
        ClassDeclaration(path) {
            if (path.node.id) {
                const isExported = t.isExportDeclaration(path.parentPath.node);
                const component = inferReactComponent(path as NodePath<t.ClassDeclaration>, isExported);
                if (component) fileComponents.push(component);
            }
        },

        // --- Declared Variables ---
        VariableDeclaration(path) {
            const kind = path.node.kind;
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
            if (tagName && /^[A-Z]/.test(tagName)) {
                jsxElementsUsed[tagName] = (jsxElementsUsed[tagName] || 0) + 1;
            }
        },

        // --- React Hooks Usage ---
        CallExpression(path) {
            // Check for direct hook calls like useState()
            if (t.isIdentifier(path.node.callee) && REACT_HOOKS.includes(path.node.callee.name)) {
                const hookName = path.node.callee.name;
                reactHooksUsed[hookName] = (reactHooksUsed[hookName] || 0) + 1;
            } 
            // Check for namespaced hook calls like React.useState()
            else if (t.isMemberExpression(path.node.callee) &&
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

        // --- Context API Detection (Provider/Consumer usage) ---
        MemberExpression(path) {
            if (t.isIdentifier(path.node.property, { name: 'Provider' })) {
                const contextName = t.isIdentifier(path.node.object) ? path.node.object.name : null;
                if (contextName) fileContextAPIs.push({ name: contextName, type: 'Provider' });
            } else if (t.isIdentifier(path.node.property, { name: 'Consumer' })) {
                const contextName = t.isIdentifier(path.node.object) ? path.node.object.name : null;
                if (contextName) fileContextAPIs.push({ name: contextName, type: 'Consumer' });
            }
        },

        // --- Type Declarations & Usage ---
        TSTypeAliasDeclaration(path) {
            declaredTypes.push({ name: path.node.id.name, isExported: !!path.parentPath && t.isExportNamedDeclaration(path.parentPath.node), kind: 'typeAlias' });
        },
        TSInterfaceDeclaration(path) {
            declaredTypes.push({ name: path.node.id.name, isExported: !!path.parentPath && t.isExportNamedDeclaration(path.parentPath.node), kind: 'interface' });
        },
        TSEnumDeclaration(path) {
            declaredTypes.push({ name: path.node.id.name, isExported: !!path.parentPath && t.isExportNamedDeclaration(path.parentPath.node), kind: 'enum' });
        },
        TSTypeReference(path) {
            if (t.isIdentifier(path.node.typeName)) {
                const typeName = path.node.typeName.name;
                typesUsedInAnnotations[typeName] = (typesUsedInAnnotations[typeName] || 0) + 1;
            }
        }
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
      loc: loc,
      declaredTypes: declaredTypes.filter((dt, i, a) => a.findIndex(t => t.name === dt.name) === i),
      typesUsedInAnnotations: Object.entries(typesUsedInAnnotations).map(([name, count]) => ({ name, count })),
    });
  }

  console.log(chalk.blue('✅ Quantum AST Analysis completed. Deep insights extracted with ultimate precision!\n'));
  return analyzedDependencies;
}
