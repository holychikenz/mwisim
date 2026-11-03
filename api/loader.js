// Custom Node.js loader to handle extensionless imports and JSON imports for the combatsimulator modules
import { resolve as pathResolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

export async function resolve(specifier, context, nextResolve) {
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
