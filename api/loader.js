// Custom Node.js loader to handle extensionless imports and JSON imports for the combatsimulator modules
import { resolve as pathResolve, dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { existsSync, readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_NODE_MODULES = join(__dirname, '../node_modules');
const API_NODE_MODULES = join(__dirname, 'node_modules');

function resolvePackageMain(packagePath) {
  const pkgJsonPath = join(packagePath, 'package.json');
  if (existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
      // Prefer ESM exports, then module, then main
      if (pkg.exports) {
        if (typeof pkg.exports === 'string') {
          return join(packagePath, pkg.exports);
        }
        if (pkg.exports['.']) {
          const exp = pkg.exports['.'];
          if (typeof exp === 'string') {
            return join(packagePath, exp);
          }
          if (exp.import) {
            return join(packagePath, exp.import);
          }
          if (exp.default) {
            return join(packagePath, exp.default);
          }
        }
      }
      if (pkg.module) {
        return join(packagePath, pkg.module);
      }
      if (pkg.main) {
        return join(packagePath, pkg.main);
      }
    } catch {}
  }
  // Fallback to index.js
  return join(packagePath, 'index.js');
}

export async function resolve(specifier, context, nextResolve) {
  // Handle bare module imports from combatsimulator files
  // Redirect to either root or api node_modules
  if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('node:') && !specifier.startsWith('file:')) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();

    // Check if this is from the combatsimulator directory
    if (parentPath.includes('/src/combatsimulator/')) {
      // Try api node_modules first, then root
      const apiModulePath = join(API_NODE_MODULES, specifier);
      const rootModulePath = join(ROOT_NODE_MODULES, specifier);

      let modulePath = null;
      if (existsSync(apiModulePath)) {
        modulePath = apiModulePath;
      } else if (existsSync(rootModulePath)) {
        modulePath = rootModulePath;
      }

      if (modulePath) {
        const mainFile = resolvePackageMain(modulePath);
        if (existsSync(mainFile)) {
          return {
            shortCircuit: true,
            url: pathToFileURL(mainFile).href
          };
        }
      }
    }
  }

  // Handle relative imports
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
    const parentDir = dirname(parentPath);

    // Check if the specifier is missing .js extension
    if (!specifier.endsWith('.js') && !specifier.endsWith('.json')) {
      const fullPath = pathResolve(parentDir, specifier);

      // Try adding .js extension
      if (existsSync(fullPath + '.js')) {
        return nextResolve(specifier + '.js', context);
      }

      // Try index.js
      if (existsSync(fullPath + '/index.js')) {
        return nextResolve(specifier + '/index.js', context);
      }
    }

    // Handle JSON imports by adding the required attribute
    if (specifier.endsWith('.json')) {
      const result = await nextResolve(specifier, context);
      return {
        ...result,
        importAttributes: { type: 'json' }
      };
    }
  }

  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  // Force JSON type for .json files
  if (url.endsWith('.json')) {
    return nextLoad(url, { ...context, importAttributes: { type: 'json' } });
  }
  return nextLoad(url, context);
}
