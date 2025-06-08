// fusion-engine/modules/analyzer/projectScanner.ts
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';

/**
 * Represents a single scanned file with advanced metadata and inferred roles.
 */
export interface ScannedFile {
  absolutePath: string;     // Full absolute path
  relativePath: string;     // Path relative to the project root
  extension: string;        // e.g., '.ts', '.jsx'
  fileName: string;         // e.g., 'index.tsx'
  baseName: string;         // File name without extension, e.g., 'index'
  sizeKB: number;           // File size in kilobytes
  inferredRole?: 'component' | 'hook' | 'util' | 'page' | 'api' | 'config' | 'style' | 'asset' | 'other'; // Inferred file role
  inferredFrameworkSpecific?: 'nextjs-page' | 'remix-route' | 'vite-entry' | 'cra-entry' | null; // Framework-specific inferences
}

/**
 * Defines the structure of a project after being intelligently scanned and partially inferred.
 */
export interface ScannedProject {
  name: string;             // Project name
  rootPath: string;         // Absolute root path
  codeFiles: ScannedFile[]; // Details of relevant code files with inferred roles
  configFiles: ScannedFile[]; // Important configuration files
  hasTypeScript: boolean;   // Project uses TypeScript
  usesReact: boolean;       // Project potentially uses React (based on dependencies/extensions)
  packageJsonData: Record<string, any> | null; // Parsed package.json content
  inferredFramework: 'Next.js' | 'Remix' | 'Create React App' | 'Vite' | 'Unknown'; // Inferred web framework
}

const ALLOWED_CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];
const CONFIG_FILES_TO_DETECT = [
  'package.json', 'tsconfig.json', 'next.config.js', 'remix.config.js',
  'vite.config.ts', 'webpack.config.js', '.env', '.eslintrc.js',
  'tailwind.config.js',
];
const STYLE_EXTENSIONS = ['.css', '.scss', '.less'];
const EXCLUDE_DIRS = ['node_modules', '.git', '.vscode', '.next', '.parcel-cache', 'dist', 'build', 'out', 'coverage'];

/** Infers file role based on path/name heuristics. */
const inferFileRole = (filePath: string, projectRoot: string): ScannedFile['inferredRole'] => {
  const relative = path.relative(projectRoot, filePath).toLowerCase();
  const fileName = path.basename(filePath).toLowerCase();
  if (fileName.includes('hook') || relative.includes('hooks')) return 'hook';
  if (fileName.includes('util') || relative.includes('utils')) return 'util';
  if (relative.includes('pages/') || relative.includes('app/') || relative.includes('routes/')) return 'page'; // Covers Next.js, Remix, CRA
  if (relative.includes('components/')) return 'component';
  if (relative.includes('api/')) return 'api';
  if (relative.includes('config/') || relative.includes('configs')) return 'config';
  if (STYLE_EXTENSIONS.some(ext => fileName.endsWith(ext))) return 'style';
  if (fileName.match(/\.(png|jpe?g|gif|svg|webp|mp3|mp4|mov)$/i)) return 'asset';
  return 'other';
};


/** Infers framework-specific file roles. */
const inferFrameworkSpecificRole = (filePath: string, projectRoot: string): ScannedFile['inferredFrameworkSpecific'] | null => {
  const relative = path.relative(projectRoot, filePath).toLowerCase();
  if (relative.startsWith('pages/') && path.extname(filePath) !== '') return 'nextjs-page';
  if (relative.startsWith('app/routes/') && path.extname(filePath) !== '') return 'remix-route';
  if (['src/index.tsx', 'src/index.jsx', 'src/main.tsx', 'src/main.jsx'].includes(relative)) return 'cra-entry';
  return null;
};


/**
 * Performs an intelligent, deep scan of project directories, collecting rich metadata
 * and attempting to infer file roles and framework usage based on conventions.
 */
export function scanProjects(projectPaths: string[]): ScannedProject[] {
  console.log(chalk.blue('\n🚀 Initiating Intelligent Project Scan: Discovering Code DNA...'));
  const scannedProjects: ScannedProject[] = [];

  for (const projectPath of projectPaths) {
    const absoluteProjectPath = path.resolve(process.cwd(), projectPath);
    if (!fs.existsSync(absoluteProjectPath) || !fs.statSync(absoluteProjectPath).isDirectory()) {
      console.warn(chalk.yellow(`⚠️  Warning: Project path "${projectPath}" not found or is not a directory. Skipping.`));
      continue;
    }

    const projectName = path.basename(absoluteProjectPath);
    const projectCodeFiles: ScannedFile[] = [];
    const projectConfigFiles: ScannedFile[] = [];
    let hasTypeScript = false;
    let usesReact = false;
    let packageJsonData: Record<string, any> | null = null;
    let inferredFramework: ScannedProject['inferredFramework'] = 'Unknown';

    console.log(chalk.cyan(`  🧬 Analyzing Project DNA: ${projectName} at ${absoluteProjectPath}`));

    const walkDir = (currentDirPath: string) => {
      for (const entry of fs.readdirSync(currentDirPath, { withFileTypes: true })) {
        const entryPath = path.join(currentDirPath, entry.name);
        const relativeEntryPath = path.relative(absoluteProjectPath, entryPath);

        if (entry.isDirectory()) {
          if (EXCLUDE_DIRS.includes(entry.name.toLowerCase()) || entry.name.startsWith('.')) continue;
          walkDir(entryPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          const fileName = entry.name;
          const baseName = path.basename(entry.name, ext);
          const stats = fs.statSync(entryPath);
          const sizeKB = parseFloat((stats.size / 1024).toFixed(2));
          
          const fileMetadata: ScannedFile = {
            absolutePath: entryPath, relativePath: relativeEntryPath, extension: ext,
            fileName, baseName, sizeKB,
          };

          if (ALLOWED_CODE_EXTENSIONS.includes(ext)) {
            projectCodeFiles.push({
              ...fileMetadata,
              inferredRole: inferFileRole(entryPath, absoluteProjectPath),
              inferredFrameworkSpecific: inferFrameworkSpecificRole(entryPath, absoluteProjectPath),
            });
            if (ext === '.ts' || ext === '.tsx') hasTypeScript = true;
          }

          if (CONFIG_FILES_TO_DETECT.includes(fileName.toLowerCase())) {
            projectConfigFiles.push({ ...fileMetadata, inferredRole: 'config' });
            if (fileName === 'package.json') {
              try {
                packageJsonData = JSON.parse(fs.readFileSync(entryPath, 'utf8'));
                // ✅ این چک `if (packageJsonData)` حالا در جای درسته
                // ✅ قبل از دسترسی به هر پراپرتی از packageJsonData
                if (packageJsonData) { 
                    if (packageJsonData.dependencies?.react || packageJsonData.devDependencies?.react) {
                        usesReact = true;
                    }
                    if (packageJsonData.dependencies?.next || packageJsonData.devDependencies?.next) {
                        inferredFramework = 'Next.js';
                    } else if (packageJsonData.dependencies?.['@remix-run/react'] || packageJsonData.devDependencies?.['@remix-run/dev']) {
                        inferredFramework = 'Remix';
                    } else if (packageJsonData.dependencies?.react && packageJsonData.devDependencies?.['react-scripts']) {
                        inferredFramework = 'Create React App';
                    } else if (packageJsonData.devDependencies?.vite) {
                        inferredFramework = 'Vite';
                    }
                }
              } catch (e) {
                console.warn(chalk.yellow(`      ⚠️  Could not parse package.json at ${entryPath}`));
                packageJsonData = null; // اگر parse نشد، null بمونه
              }
            } else if (fileName === 'tsconfig.json') {
              hasTypeScript = true;
            }
          }
        }
      }
    };

    walkDir(absoluteProjectPath);

    if (projectCodeFiles.length === 0 && projectConfigFiles.length === 0) {
      console.warn(chalk.yellow(`    ⚠️  No relevant files found in project "${projectName}". Project might be empty.`));
    } else {
      console.log(chalk.green(`    ✅ Scan complete for "${projectName}". (${projectCodeFiles.length} code files, ${projectConfigFiles.length} config files)`));
      console.log(chalk.gray(`      Insights: TS: ${hasTypeScript ? 'Yes' : 'No'}, React: ${usesReact ? 'Yes' : 'No'}, Framework: ${inferredFramework}`));
    }

    scannedProjects.push({
      name: projectName, rootPath: absoluteProjectPath,
      codeFiles: projectCodeFiles, configFiles: projectConfigFiles,
      hasTypeScript, usesReact, packageJsonData, inferredFramework,
    });
  }

  console.log(chalk.blue('🎉 Intelligent Project Scan completed.\n'));
  return scannedProjects;
}