const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'src');

const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const target = path.join(directory, entry.name);
  if (entry.isDirectory()) return walk(target);
  return entry.isFile() && target.endsWith('.ts') ? [target] : [];
});

const files = walk(sourceRoot);
const fileSet = new Set(files);
const relative = (file) => path.relative(root, file).replaceAll(path.sep, '/');
const resolveLocalImport = (fromFile, specifier) => {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  return [`${base}.ts`, path.join(base, 'index.ts')]
    .find((candidate) => fileSet.has(candidate)) ?? null;
};

const graph = new Map();
const violations = [];
const directSqlRouteAllowlist = new Set([
  'src/routes/database.ts',
  'src/routes/gmail.ts',
  'src/routes/monitoring.ts',
]);

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const imports = [...source.matchAll(/(?:from\s+|require\()['"]([^'"]+)['"]/g)]
    .map((match) => resolveLocalImport(file, match[1]))
    .filter(Boolean);
  graph.set(file, imports);

  const name = relative(file);
  const isInnerModule = name.startsWith('src/services/')
    || name.startsWith('src/models/')
    || name.startsWith('src/core/');
  if (isInnerModule && imports.some((dependency) => relative(dependency).startsWith('src/middleware/'))) {
    violations.push(`${name}: inner modules must not import HTTP middleware`);
  }
  if (name.startsWith('src/routes/') && /\.query\s*\(/.test(source) && !directSqlRouteAllowlist.has(name)) {
    violations.push(`${name}: new route-level SQL is forbidden`);
  }
  if ((/new\s+PostgresService\s*\(/.test(source) || /new\s+CacheService\s*\(/.test(source))
      && name !== 'src/services/core/ServiceContainer.ts') {
    violations.push(`${name}: process-wide resources must be created in ServiceContainer`);
  }
}

const visiting = new Set();
const visited = new Set();
const stack = [];
const cycles = new Set();
const visit = (file) => {
  if (visiting.has(file)) {
    const start = stack.indexOf(file);
    cycles.add([...stack.slice(start), file].map(relative).join(' -> '));
    return;
  }
  if (visited.has(file)) return;
  visiting.add(file);
  stack.push(file);
  for (const dependency of graph.get(file) ?? []) visit(dependency);
  stack.pop();
  visiting.delete(file);
  visited.add(file);
};
for (const file of files) visit(file);

for (const cycle of cycles) violations.push(`dependency cycle: ${cycle}`);
if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Architecture check passed for ${files.length} TypeScript modules.`);
}
