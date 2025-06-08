// fusion-engine/core/validator/dependencyChecker.ts
import path from 'path';
import fs from 'fs';
import chalk from 'chalk';
import semver from 'semver'; // For robust version comparison

// Import interfaces
import { SimpleScannedFile, ValidationIssue } from './interfaces';

interface PackageJson {
  name: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

/**
 * Validates package.json files across projects for version conflicts and common issues.
 * This is a "super cool" dependency checker, providing detailed insights.
 *
 * @param scannedFiles A list of SimpleScannedFile objects from the projectScanner.
 * @param projectRoots A list of absolute project root paths to associate package.json files.
 * @returns A promise that resolves to an array of ValidationIssue objects.
 */
export async function checkDependencies(
  scannedFiles: SimpleScannedFile[],
  projectRoots: string[] // Pass actual project roots for better context
): Promise<ValidationIssue[]> {
  console.log(chalk.blue('\n📦 Running Dependency Checker: Unveiling Package Conflicts with Super Precision...'));
  const issues: ValidationIssue[] = [];
  const packageJsonFiles = scannedFiles.filter(file => file.fileName === 'package.json');

  if (packageJsonFiles.length === 0) {
    issues.push({
      type: 'warning',
      message: 'No package.json files found in scanned projects. Dependency validation skipped.',
      details: 'Fusion Engine relies on package.json for dependency management. Please ensure your projects have one.',
    });
    console.warn(chalk.yellow('    ⚠️  No package.json files found.'));
    return issues;
  }

  const allDependencies = new Map<string, Map<string, string>>(); // packageName -> Map<versionSpec -> projectRelativePath>
  const packageJsonDataMap = new Map<string, PackageJson>(); // projectRelativePath -> parsed package.json

  for (const pkgFile of packageJsonFiles) {
    try {
      const content = await fs.promises.readFile(pkgFile.absolutePath, 'utf8');
      const pkgJson: PackageJson = JSON.parse(content);
      packageJsonDataMap.set(pkgFile.relativePath, pkgJson); // Store parsed data

      const currentProjectRoot = projectRoots.find(root => pkgFile.absolutePath.startsWith(root));
      const currentProjectName = currentProjectRoot ? path.basename(currentProjectRoot) : 'Unknown Project';

      // Aggregate all dependencies for conflict detection
      const processDeps = (deps: Record<string, string> | undefined) => {
        if (deps) {
          for (const [pkgName, versionSpec] of Object.entries(deps)) {
            if (!allDependencies.has(pkgName)) {
              allDependencies.set(pkgName, new Map<string, string>());
            }
            allDependencies.get(pkgName)!.set(versionSpec, pkgFile.relativePath); // Store package version spec and its origin
          }
        }
      };

      processDeps(pkgJson.dependencies);
      processDeps(pkgJson.devDependencies);
      processDeps(pkgJson.peerDependencies); // Peer dependencies also contribute to conflicts

    } catch (error: any) {
      issues.push({
        type: 'error',
        message: `Failed to parse package.json for validation: ${pkgFile.relativePath}`,
        details: `Error: ${error.message}. Please ensure it's valid JSON.`,
        filePath: pkgFile.relativePath,
      });
      console.error(chalk.red(`    ❌ Failed to parse package.json: ${pkgFile.relativePath}`));
    }
  }

  // --- Detailed Conflict Detection with Semantic Versioning Insights ---
  for (const [pkgName, versionsMap] of allDependencies.entries()) {
    if (versionsMap.size > 1) { // More than one version specifier found for the same package
      const uniqueNormalizedVersions: Set<string> = new Set();
      const versionDetails: { versionSpec: string; normalized: string; projects: string[] }[] = [];

      for (const [versionSpec, relativeProjectPath] of versionsMap.entries()) {
        const normalizedVersion = semver.coerce(versionSpec)?.version;
        const projectName = path.basename(path.dirname(path.dirname(relativeProjectPath))); // Get project name

        if (normalizedVersion) {
            uniqueNormalizedVersions.add(normalizedVersion);
            versionDetails.push({ versionSpec, normalized: normalizedVersion, projects: [projectName] });
        } else {
            // Handle non-semver versions (e.g., git URLs, local paths)
            versionDetails.push({ versionSpec, normalized: versionSpec, projects: [projectName] }); // Use spec as normalized
            uniqueNormalizedVersions.add(versionSpec);
        }
      }

      if (uniqueNormalizedVersions.size > 1) { // Actual different normalized versions or non-semver specs found
        let conflictType: 'major' | 'minor' | 'patch' | 'other' = 'other';
        const sortedNormalizedVersions = Array.from(uniqueNormalizedVersions).sort(semver.compare);

        if (sortedNormalizedVersions.length >= 2) {
            const diff = semver.diff(sortedNormalizedVersions[0], sortedNormalizedVersions[sortedNormalizedVersions.length - 1]);
            if (diff === 'major') conflictType = 'major';
            else if (diff === 'minor') conflictType = 'minor';
            else if (diff === 'patch') conflictType = 'patch';
        }
        
        const conflictMessage = `Package version conflict (${conflictType} difference) for "${pkgName}".`;
        const conflictDetails = `Found: ${versionDetails.map(d => `${d.versionSpec} (normalized: ${d.normalized}, in ${d.projects.join(', ')})`).join('; ')}. ` +
                                `Major conflicts (${chalk.red('breaking changes likely')}) should be resolved. Minor/patch conflicts (${chalk.yellow('may cause issues')}) are less critical.`;
        
        issues.push({
          type: conflictType === 'major' ? 'error' : 'warning', // Major version conflicts are critical errors
          message: conflictMessage,
          details: conflictDetails,
        });
        console.warn(chalk.yellow(`    ⚠️  Conflict: ${pkgName} - ${Array.from(uniqueNormalizedVersions).join('/')} (Type: ${conflictType})`));
      } else if (uniqueNormalizedVersions.size === 1 && versionsMap.size > 1) {
          // Same normalized version, but different specifiers (e.g., "1.0.0" and "^1.0.0")
          issues.push({
              type: 'warning',
              message: `Redundant version specifiers for "${pkgName}".`,
              details: `Multiple specifiers resolve to the same version (${Array.from(uniqueNormalizedVersions)[0]}): ${Array.from(versionsMap.keys()).join(', ')}. ` +
                       `Consider unifying to a single specifier for consistency.`,
              filePath: versionsMap.values().next().value, // Just pick one file path
          });
          console.warn(chalk.yellow(`    ⚠️  Redundant Specifiers: ${pkgName} - ${Array.from(versionsMap.keys()).join('/')}`));
      }
    }
  }

  // --- Advanced Dependency Checks per Project ---
  for (const pkgFile of packageJsonFiles) {
      const pkgJson = packageJsonDataMap.get(pkgFile.relativePath);
      if (!pkgJson) continue; // Should not happen if map is correctly populated

      const projectName = path.basename(path.dirname(path.dirname(pkgFile.relativePath))); // Get project name

      // Check for redundant dependencies (e.g., in both dependencies and devDependencies)
      if (pkgJson.dependencies && pkgJson.devDependencies) {
          for (const depName in pkgJson.dependencies) {
              if (pkgJson.devDependencies[depName]) {
                  issues.push({
                      type: 'warning',
                      message: `Redundant dependency: "${depName}" is listed in both 'dependencies' and 'devDependencies' in "${projectName}".`,
                      details: `It should typically be in one or the other based on its usage (runtime vs. development).`,
                      filePath: pkgFile.relativePath,
                  });
                  console.warn(chalk.yellow(`    ⚠️  Redundant: ${depName} in ${projectName} (dep & devDep)`));
              }
          }
      }

      // Check peerDependencies satisfaction (basic check: if declared, is it actually installed/provided?)
      if (pkgJson.peerDependencies) {
          for (const peerDepName in pkgJson.peerDependencies) {
              const peerDepVersionRange = pkgJson.peerDependencies[peerDepName];
              const isProvidedByDep = (pkgJson.dependencies && pkgJson.dependencies[peerDepName]) ||
                                      (pkgJson.devDependencies && pkgJson.devDependencies[peerDepName]);

              if (!isProvidedByDep) {
                  // This is a common warning for libraries: peerDep should be installed by consumer.
                  // But if it's an application, it might be a missing install.
                  issues.push({
                      type: 'warning',
                      message: `Peer dependency "${peerDepName}@${peerDepVersionRange}" not explicitly listed in 'dependencies' or 'devDependencies' in "${projectName}".`,
                      details: `For applications, ensure peer dependencies are explicitly installed. For libraries, this is expected behavior.`,
                      filePath: pkgFile.relativePath,
                  });
                  console.warn(chalk.yellow(`    ⚠️  Peer Dep: ${peerDepName} not satisfied in ${projectName}`));
              } else {
                  // Check if the provided version satisfies the peer dependency range
                  const providedVersion = pkgJson.dependencies?.[peerDepName] || pkgJson.devDependencies?.[peerDepName];
                  if (providedVersion && !semver.satisfies(semver.coerce(providedVersion)!, peerDepVersionRange)) {
                      issues.push({
                          type: 'warning',
                          message: `Peer dependency "${peerDepName}@${peerDepVersionRange}" not satisfied by installed version "${providedVersion}" in "${projectName}".`,
                          details: `The installed version does not meet the peer dependency's requirements.`,
                          filePath: pkgFile.relativePath,
                      });
                      console.warn(chalk.yellow(`    ⚠️  Peer Dep Mismatch: ${peerDepName} in ${projectName} (installed: ${providedVersion}, required: ${peerDepVersionRange})`));
                  }
              }
          }
      }
  }

  // --- Missing DevDependencies Check (Heuristic - remains) ---
  const possibleBuildTools = new Map<string, string>([
    ['typescript', 'tsconfig.json'],
    ['react-scripts', 'package.json (Create React App)'],
    ['vite', 'vite.config.ts'],
    ['next', 'next.config.js'],
  ]);

  for (const root of projectRoots) {
      const packageJsonPath = path.join(root, 'package.json');
      let pkgJson: PackageJson | undefined = undefined;
      const relativePkgJsonPath = path.relative(process.cwd(), packageJsonPath);

      // Try to get pkgJson from map first, otherwise read from disk
      if (packageJsonDataMap.has(relativePkgJsonPath)) {
          pkgJson = packageJsonDataMap.get(relativePkgJsonPath);
      } else {
          try {
              const content = fs.readFileSync(packageJsonPath, 'utf8');
              pkgJson = JSON.parse(content);
          } catch (e) { /* ignore, error already logged */ }
      }

      if (pkgJson) {
          const projectFiles = scannedFiles.filter(f => f.absolutePath.startsWith(root));
          const hasTsFiles = projectFiles.some(f => f.extension === '.ts' || f.extension === '.tsx');
          const devDependencies = pkgJson.devDependencies || {};

          if (hasTsFiles && !devDependencies['typescript']) {
              issues.push({
                  type: 'warning',
                  message: `TypeScript files detected in "${path.basename(root)}" but "typescript" is not in devDependencies.`,
                  details: `Consider adding "typescript" to devDependencies to ensure proper compilation.`,
                  filePath: relativePkgJsonPath,
              });
              console.warn(chalk.yellow(`    ⚠️  Missing devDep: typescript in ${path.basename(root)}`));
          }

          for(const [tool, configFile] of possibleBuildTools.entries()){
              if (pkgJson.dependencies?.[tool] || pkgJson.devDependencies?.[tool]) continue; // Tool is already present
              const hasConfigFile = projectFiles.some(f => f.fileName === configFile);
              if (hasConfigFile) {
                   issues.push({
                      type: 'warning',
                      message: `Project "${path.basename(root)}" appears to use ${tool} (via ${configFile}) but it's not in dependencies/devDependencies.`,
                      details: `Ensure "${tool}" is correctly installed and listed in package.json.`,
                      filePath: relativePkgJsonPath,
                  });
                   console.warn(chalk.yellow(`    ⚠️  Missing tool: ${tool} in ${path.basename(root)}`));
              }
          }
      }
  }

  console.log(chalk.blue('✅ Dependency Checker completed with Super Precision.'));
  return issues;
}
