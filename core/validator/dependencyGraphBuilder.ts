// src/modules/analyzer/dependencyGraphBuilder.ts
import path from 'path';
import fs from 'fs'; // Used for path resolution validation (e.g., check file existence)
import chalk from 'chalk';

import { AnalyzedProject, ASTDependency } from './workspaceAnalyzer';

// --- Interfaces ---
export interface FileNode {
  id: string; // Unique identifier, typically the relative file path (e.g., 'src/components/Button.tsx')
  name: string; // Base file name (e.g., 'Button.tsx')
  type: 'component' | 'page' | 'hook' | 'utility' | 'config' | 'asset' | 'api' | 'style' | 'unknown'; // Added 'style' and 'unknown'
  absolutePath: string; // Absolute path for full context
  loc?: number; // Lines of code
  isEntryFile?: boolean; // Is it a likely entry point (e.g., src/index.tsx, main.tsx)?
  hasJSX?: boolean; // Does the file contain JSX?
  exportsCount?: number; // Number of exported items
  importsCount?: number; // Number of imported items
  componentsDeclared?: number; // Number of components defined in this file
}

export interface DependencyEdge {
  from: string; // ID of the source node (relative file path)
  to: string;   // ID of the target node (relative file path)
  type: 'import' | 'dynamic-import' | 'reference' | 'context-usage' | 'hoc-usage' | 'render-usage' | 'type-dependency';
  weight?: number; // How strong is the dependency (e.g., number of imports)
  importedNames?: string[]; // Specific items imported (e.g., ['Button', 'useMyHook'])
  reason?: string; // Optional: A brief description for complex edges
}

export interface DependencyGraph {
  nodes: FileNode[];
  edges: DependencyEdge[];
  totalNodes: number;
  totalEdges: number;
  unresolvedImports: { from: string; importPath: string; reason: string }[]; // List of imports that couldn't be resolved
}

// --- Constants & Helpers ---

const COMMON_FILE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json', '.css', '.scss', '.less', '.png', '.svg'];
const ENTRY_FILE_PATTERNS = new Set(['src/index.tsx', 'src/index.jsx', 'src/main.tsx', 'src/main.jsx', 'app/layout.tsx', 'app/page.tsx', 'pages/_app.tsx', 'pages/index.tsx']);

/**
 * Infers the high-level type of a file node based on its AST analysis and inferred roles.
 * Prioritizes more specific roles.
 * @param fileAnalysis The AST analysis result for a file.
 * @returns The inferred type of the file node.
 */
function inferFileType(fileAnalysis: Omit<ASTDependency, 'file'>): FileNode['type'] {
  if (fileAnalysis.file.inferredRole === 'page' || fileAnalysis.file.inferredFrameworkSpecific?.includes('page')) return 'page';
  if (fileAnalysis.components.length > 0) return 'component';
  if (fileAnalysis.reactHooksUsed && Object.keys(fileAnalysis.reactHooksUsed).length > 0) return 'hook';
  if (fileAnalysis.contextAPIs && fileAnalysis.contextAPIs.length > 0) return 'utility'; // Context itself is a utility
  if (fileAnalysis.file.inferredRole === 'util') return 'utility';
  if (fileAnalysis.file.inferredRole === 'api') return 'api';
  if (fileAnalysis.file.inferredRole === 'config') return 'config';
  if (fileAnalysis.file.inferredRole === 'asset') return 'asset';
  if (fileAnalysis.file.inferredRole === 'style') return 'style'; // Explicitly use style role

  // Fallback based on common conventions and file structure
  if (fileAnalysis.file.relativePath.toLowerCase().includes('routes/')) return 'page'; // Remix convention
  if (fileAnalysis.file.relativePath.toLowerCase().includes('layouts/')) return 'component'; // Common layout components
  if (fileAnalysis.file.extension === '.json') return 'config'; // JSON files often config
  if (fileAnalysis.file.extension === '.css' || fileAnalysis.file.extension === '.scss' || fileAnalysis.file.extension === '.less') return 'style'; // Explicit style files

  // Default for general code files or if no specific role detected
  if (fileAnalysis.file.extension === '.ts' || fileAnalysis.file.extension === '.js' || fileAnalysis.file.extension === '.tsx' || fileAnalysis.file.extension === '.jsx') return 'utility';

  return 'unknown'; // If nothing specific is inferred
}

/**
 * Robustly resolves an import source path to a valid file path within the analyzed project.
 * Supports relative, absolute (project-internal), and attempts to resolve common file extensions.
 * Requires the `rootPath` of the analyzed project for proper absolute path resolution.
 * @param fromFilePath The relative path of the file making the import.
 * @param importSource The raw import string (e.g., './Button', 'react', '@/utils/helpers').
 * @param analyzedFilesMap The map of analyzed files (relative path -> analysis result).
 * @param projectRootPath The absolute root path of the current project.
 * @returns The relative path of the resolved file, or null if not found/resolved.
 */
function resolveImportPath(
  fromFilePath: string,
  importSource: string,
  analyzedFilesMap: AnalyzedProject['analyzedFiles'],
  projectRootPath: string
): string | null {
  const fromDir = path.dirname(fromFilePath);

  // 1. Handle Node.js built-in modules or external packages (not resolvable within project)
  if (!importSource.startsWith('.') && !importSource.startsWith('/') && !importSource.startsWith('@')) {
    return null;
  }

  const possiblePathsToTry: string[] = [];

  // 2. Handle relative imports (e.g., './components/Button', '../styles')
  if (importSource.startsWith('.')) {
    const resolvedAbsolutePath = path.resolve(projectRootPath, fromDir, importSource);
    possiblePathsToTry.push(path.relative(projectRootPath, resolvedAbsolutePath));
  } else { // 3. Handle absolute project-internal imports or aliases (e.g., '/utils/helpers', '@/components')
    let baseResolvedPath = importSource;
    if (importSource.startsWith('/')) {
      baseResolvedPath = importSource.substring(1);
    } else if (importSource.startsWith('@/')) {
      baseResolvedPath = importSource.substring(2);
    }
    possiblePathsToTry.push(baseResolvedPath);
    possiblePathsToTry.push(path.join('src', baseResolvedPath)); // Common for absolute imports from src
  }

  // Attempt to resolve by trying various extensions and '/index'
  for (const basePath of possiblePathsToTry) {
    if (analyzedFilesMap[basePath]) return basePath; // Exact match

    for (const ext of COMMON_FILE_EXTENSIONS) {
      const tryPathWithExt = basePath.endsWith(ext) ? basePath : `${basePath}${ext}`;
      if (analyzedFilesMap[tryPathWithExt]) return tryPathWithExt;

      const tryIndexPath = path.join(basePath, `index${ext}`);
      if (analyzedFilesMap[tryIndexPath]) return tryIndexPath;
    }
  }

  return null;
}


/**
 * Builds a comprehensive dependency graph for a single analyzed project.
 * @param analysis The full analysis result for a single project from `workspaceAnalyzer.ts`.
 * @returns A DependencyGraph object representing the connections within the project.
 */
export function buildDependencyGraph(analysis: AnalyzedProject): DependencyGraph {
  console.log(chalk.blue(`\n  Graphing dependencies for project: ${analysis.name}...`));

  const nodes: FileNode[] = [];
  const edges: DependencyEdge[] = [];
  const processedEdges = new Set<string>(); // To prevent duplicate edges
  const unresolvedImports: DependencyGraph['unresolvedImports'] = [];

  // --- Step 1: Extract Nodes ---
  for (const [relativePath, fileAnalysis] of Object.entries(analysis.analyzedFiles)) {
    const isEntryFile = ENTRY_FILE_PATTERNS.has(relativePath.toLowerCase());
    nodes.push({
      id: relativePath,
      name: fileAnalysis.file.fileName,
      type: inferFileType(fileAnalysis),
      absolutePath: fileAnalysis.file.absolutePath,
      loc: fileAnalysis.loc,
      isEntryFile: isEntryFile,
      hasJSX: fileAnalysis.components.length > 0 || fileAnalysis.jsxElementsUsed.length > 0,
      exportsCount: fileAnalysis.exports.length,
      importsCount: fileAnalysis.imports.length,
      componentsDeclared: fileAnalysis.components.length,
    });
  }
  console.log(chalk.green(`    Extracted ${nodes.length} file nodes.`));

  // Create quick lookup maps for exported components and types
  const componentExportsMap = new Map<string, string>(); // ComponentName -> RelativeFilePath
  const typeExportsMap = new Map<string, string>(); // TypeName -> RelativeFilePath (New for type-dependency)

  for (const [relativePath, fileAnalysis] of Object.entries(analysis.analyzedFiles)) {
    for (const comp of fileAnalysis.components) {
      if (comp.isExported) {
        componentExportsMap.set(comp.name, relativePath);
      }
    }
    // Populate typeExportsMap if declaredTypes is available from ASTDependency
    if (fileAnalysis.declaredTypes) {
      for (const typeDef of fileAnalysis.declaredTypes) {
        if (typeDef.isExported) {
          typeExportsMap.set(typeDef.name, relativePath);
        }
      }
    }
  }


  // --- Step 2: Extract Edges ---
  for (const [sourcePath, fileAnalysis] of Object.entries(analysis.analyzedFiles)) {
    // 2.1. Import Edges (Static & Dynamic)
    for (const imp of fileAnalysis.imports) {
      const edgeType: DependencyEdge['type'] = imp.path.includes('import(') ? 'dynamic-import' : 'import';

      const resolvedTargetPath = resolveImportPath(sourcePath, imp.path, analysis.analyzedFiles, analysis.rootPath);

      if (resolvedTargetPath && sourcePath !== resolvedTargetPath) {
        const edgeId = `${sourcePath} -> ${resolvedTargetPath} (${edgeType})`;
        if (!processedEdges.has(edgeId)) {
          edges.push({
            from: sourcePath,
            to: resolvedTargetPath,
            type: edgeType,
            importedNames: [imp.importedAs || imp.name],
          });
          processedEdges.add(edgeId);
        } else {
            const existingEdge = edges.find(e => e.from === sourcePath && e.to === resolvedTargetPath && e.type === edgeType);
            if (existingEdge && imp.importedAs && !existingEdge.importedNames?.includes(imp.importedAs)) {
                existingEdge.importedNames?.push(imp.importedAs);
            } else if (existingEdge && imp.name && !existingEdge.importedNames?.includes(imp.name)) {
                existingEdge.importedNames?.push(imp.name);
            }
        }
      } else if (!resolvedTargetPath && !imp.path.startsWith('.') && !imp.path.startsWith('/') && !imp.path.startsWith('@')) {
        // This is an external/node_module import, not unresolved internal.
      } else if (!resolvedTargetPath && sourcePath !== imp.path) {
        unresolvedImports.push({ from: sourcePath, importPath: imp.path, reason: 'Could not resolve to an internal project file.' });
        console.warn(chalk.yellow(`    ⚠️  Unresolved import in ${sourcePath}: "${imp.path}"`));
      }
    }

    // 2.2. Render Usage Edges (Implicit dependency: Component X renders Component Y)
    // Using `jsxElementsUsed` from ASTDependency which is `name: string, count: number`
    if (fileAnalysis.jsxElementsUsed && fileAnalysis.jsxElementsUsed.length > 0) {
      for (const usedComponent of fileAnalysis.jsxElementsUsed) { // Iterate over objects, not just names
        const resolvedComponentPath = componentExportsMap.get(usedComponent.name); // Use usedComponent.name
        if (resolvedComponentPath && resolvedComponentPath !== sourcePath) {
          const edgeId = `${sourcePath} -> ${resolvedComponentPath} (render-usage)`;
          if (!processedEdges.has(edgeId)) {
            edges.push({
              from: sourcePath,
              to: resolvedComponentPath,
              type: 'render-usage',
              reason: `Component "${usedComponent.name}" rendered in JSX.`,
              importedNames: [usedComponent.name],
              weight: usedComponent.count, // Add count as weight for render usage
            });
            processedEdges.add(edgeId);
          } else {
              const existingEdge = edges.find(e => e.from === sourcePath && e.to === resolvedComponentPath && e.type === 'render-usage');
              if (existingEdge && !existingEdge.importedNames?.includes(usedComponent.name)) {
                  existingEdge.importedNames?.push(usedComponent.name);
              }
          }
        }
      }
    }

    // 2.3. Context Usage Edges (If file uses a Context.Provider/Consumer)
    for (const contextAPI of fileAnalysis.contextAPIs) {
        if (contextAPI.type === 'Provider' || contextAPI.type === 'Consumer') {
            const contextName = contextAPI.name;
            const contextDefinitionFile = Object.values(analysis.analyzedFiles).find(
                targetFileAnalysis => targetFileAnalysis.contextAPIs.some(api => api.name === contextName && api.type === 'Context')
            );
            if (contextDefinitionFile && sourcePath !== contextDefinitionFile.file.relativePath) {
                const edgeId = `${sourcePath} -> ${contextDefinitionFile.file.relativePath} (context-usage)`;
                if (!processedEdges.has(edgeId)) {
                    edges.push({
                        from: sourcePath,
                        to: contextDefinitionFile.file.relativePath,
                        type: 'context-usage',
                        importedNames: [contextName],
                        reason: `Uses React Context '${contextName}' as ${contextAPI.type}`
                    });
                    processedEdges.add(edgeId);
                }
            }
        }
    }

    // 2.4. HOC Usage Edges (If a component is wrapped by an HOC from another file)
    for (const comp of fileAnalysis.components) {
      if (comp.inferredHOC) {
        // Find where this HOC is defined (e.g., `withRouter` in a HOCs utility file)
        // This is a heuristic: assuming HOCs are exported functions/variables
        const hocDefinitionFile = Object.values(analysis.analyzedFiles).find(
            targetFileAnalysis => targetFileAnalysis.exports.some(exp => exp.name === comp.inferredHOC && (exp.type === 'function' || exp.type === 'variable'))
        );

        if (hocDefinitionFile && sourcePath !== hocDefinitionFile.file.relativePath) {
          const edgeId = `${sourcePath} -> ${hocDefinitionFile.file.relativePath} (hoc-usage)`;
          if (!processedEdges.has(edgeId)) {
            edges.push({
              from: sourcePath,
              to: hocDefinitionFile.file.relativePath,
              type: 'hoc-usage',
              importedNames: [comp.inferredHOC],
              reason: `Component "${comp.name}" is wrapped by HOC "${comp.inferredHOC}"`
            });
            processedEdges.add(edgeId);
          }
        }
      }
    }

    // 2.5. Type Dependency Edges (e.g., imported types or interfaces)
    // This assumes `typesUsedInAnnotations` is populated by `astAnalyzer.ts`
    if (fileAnalysis.typesUsedInAnnotations && fileAnalysis.typesUsedInAnnotations.length > 0) {
      for (const typeUsed of fileAnalysis.typesUsedInAnnotations) { // Iterate over objects with name/count
        const resolvedTypePath = typeExportsMap.get(typeUsed.name); // Use typeExportsMap
        if (resolvedTypePath && resolvedTypePath !== sourcePath) {
          const edgeId = `${sourcePath} -> ${resolvedTypePath} (type-dependency)`;
          if (!processedEdges.has(edgeId)) {
            edges.push({
              from: sourcePath,
              to: resolvedTypePath,
              type: 'type-dependency',
              reason: `Type "${typeUsed.name}" used in type annotations.`,
              importedNames: [typeUsed.name],
              weight: typeUsed.count, // Use count of type usage as weight
            });
            processedEdges.add(edgeId);
          } else {
              const existingEdge = edges.find(e => e.from === sourcePath && e.to === resolvedTypePath && e.type === 'type-dependency');
              if (existingEdge && !existingEdge.importedNames?.includes(typeUsed.name)) {
                  existingEdge.importedNames?.push(typeUsed.name);
              }
          }
        }
      }
    }
  }

  console.log(chalk.green(`    Constructed ${edges.length} edges.`));
  if (unresolvedImports.length > 0) {
    console.warn(chalk.red.bold(`    ❌ WARNING: ${unresolvedImports.length} imports could not be resolved to project files.`));
  }


  return {
    nodes,
    edges,
    totalNodes: nodes.length,
    totalEdges: edges.length,
    unresolvedImports,
  };
}

/**
 * Builds dependency graphs for multiple analyzed projects within the workspace.
 * @param analyzedProjects An array of `AnalyzedProject` objects.
 * @returns An array of objects, each containing an `AnalyzedProject` and its corresponding `DependencyGraph`.
 */
export function buildWorkspaceDependencyGraphs(analyzedProjects: AnalyzedProject[]): { project: AnalyzedProject; graph: DependencyGraph }[] {
    console.log(chalk.magenta('\n✨ Building Dependency Graphs for the entire workspace with advanced resolution...'));
    const allGraphs: { project: AnalyzedProject; graph: DependencyGraph }[] = [];
    for (const project of analyzedProjects) {
        allGraphs.push({
            project: project,
            graph: buildDependencyGraph(project)
        });
    }
    console.log(chalk.magenta('🎉 All Dependency Graphs built successfully!\n'));
    return allGraphs;
}