const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'src');

const walk = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
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
  return (
    [`${base}.ts`, path.join(base, 'index.ts')].find((candidate) => fileSet.has(candidate)) ?? null
  );
};

const graph = new Map();
const violations = [];
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const imports = [...source.matchAll(/(?:from\s+|require\()['"]([^'"]+)['"]/g)]
    .map((match) => resolveLocalImport(file, match[1]))
    .filter(Boolean);
  graph.set(file, imports);

  const name = relative(file);
  const isInnerModule =
    name.startsWith('src/services/') ||
    name.startsWith('src/models/') ||
    name.startsWith('src/core/');
  if (
    isInnerModule &&
    imports.some((dependency) => relative(dependency).startsWith('src/middleware/'))
  ) {
    violations.push(`${name}: inner modules must not import HTTP middleware`);
  }
  if (name.startsWith('src/routes/') && /\.query\s*\(/.test(source)) {
    violations.push(`${name}: route-level SQL is forbidden`);
  }
  if (
    name.endsWith('QueryRepository.ts') &&
    /\b(?:INSERT\s+INTO|UPDATE\s+[a-z_]|DELETE\s+FROM)\b/i.test(source)
  ) {
    violations.push(`${name}: query repositories must not perform database mutations`);
  }
  if (
    name !== 'src/config/logger.ts' &&
    name !== 'src/services/extraction/index.ts' &&
    /console\.(?:log|warn|error|debug)\s*\(/.test(source)
  ) {
    violations.push(`${name}: use the structured logger port instead of console output`);
  }
  if (
    name.startsWith('src/routes/') &&
    (imports.some(
      (dependency) => relative(dependency) === 'src/services/data/PostgresService.ts',
    ) ||
      /from\s+['"]pg['"]/.test(source) ||
      /container\.postgres\b/.test(source))
  ) {
    violations.push(`${name}: routes must not import or reach through to the PostgreSQL adapter`);
  }
  if (
    (/new\s+PostgresService\s*\(/.test(source) || /new\s+CacheService\s*\(/.test(source)) &&
    name !== 'src/services/core/ServiceContainer.ts' &&
    name !== 'src/scripts/migrate.ts'
  ) {
    violations.push(`${name}: process-wide resources must be created in ServiceContainer`);
  }
  if (
    name.startsWith('src/services/') &&
    name !== 'src/services/core/ServiceContainer.ts' &&
    name !== 'src/services/data/PostgresService.ts' &&
    imports.some((dependency) => relative(dependency) === 'src/services/data/PostgresService.ts')
  ) {
    violations.push(`${name}: services must depend on database ports, not PostgresService`);
  }
  const isApplicationService = [
    'src/services/auth/',
    'src/services/import/',
    'src/services/receipt/',
    'src/services/user/',
  ].some((prefix) => name.startsWith(prefix));
  if (
    isApplicationService &&
    imports.some((dependency) => relative(dependency).startsWith('src/services/data/'))
  ) {
    violations.push(`${name}: application services must depend on ports, not data adapters`);
  }
  if (
    isApplicationService &&
    imports.some((dependency) => relative(dependency) === 'src/services/core/CacheService.ts')
  ) {
    violations.push(`${name}: application services must depend on projection cache ports`);
  }
  const postgresDriverOwners = new Set([
    'src/services/data/PostgresService.ts',
    'src/services/data/MigrationRunner.ts',
  ]);
  if (/from\s+['"]pg['"]/.test(source) && !postgresDriverOwners.has(name)) {
    violations.push(`${name}: the PostgreSQL driver is restricted to infrastructure adapters`);
  }
  if (
    name === 'src/services/data/PostgresService.ts' &&
    /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|FUNCTION)\b/i.test(source)
  ) {
    violations.push(`${name}: schema mutation belongs in versioned migrations`);
  }

  const mutatesReceipts = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+receipts\b/i.test(source);
  const receiptMutationOwners = new Set([
    'src/services/data/ReceiptRepository.ts',
    'src/services/data/AccountResetService.ts',
    'src/services/account/ReceiptClearService.ts',
  ]);
  if (
    mutatesReceipts &&
    !receiptMutationOwners.has(name) &&
    !name.startsWith('src/services/data/migrations/')
  ) {
    violations.push(
      `${name}: receipt mutations must use ReceiptRepository or a documented writer-locked lifecycle service`,
    );
  }
}

if (fileSet.has(path.join(sourceRoot, 'services/data/ImportPreferencesRepository.ts'))) {
  violations.push(
    'src/services/data/ImportPreferencesRepository.ts: obsolete combined import repository is forbidden',
  );
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
