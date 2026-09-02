const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

/**
 * Metro in a pnpm monorepo.
 *
 * pnpm stores dependencies as symlinks into a content-addressed store, which
 * Metro does not follow by default. Watching the workspace root and adding both
 * node_modules directories is what lets this app import @transportco/ui and
 * friends from source.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
