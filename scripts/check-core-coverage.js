const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const cases = [
  [
    'src/services/auth/TokenService.ts',
    'test/auth-capabilities.test.js',
    ['malformed, expired, and revoked credentials'],
  ],
  [
    'src/services/auth/SessionService.ts',
    'test/auth-capabilities.test.js',
    ['revokes the presented refresh token before rotating'],
  ],
  [
    'src/services/OtpService.ts',
    'test/auth-capabilities.test.js',
    ['consume the code atomically', 'roll back on mutation failure'],
  ],
  [
    'src/services/account/AccountDeletionService.ts',
    'test/account-lifecycle.test.js',
    ['commits before cache cleanup', 'rolls back and releases the lock'],
  ],
  [
    'src/services/data/AccountResetService.ts',
    'test/metric-regressions.test.js',
    ['onboarding account reset waits for imports and restores fresh import state atomically'],
  ],
  [
    'src/services/import/CsvImportUseCase.ts',
    'test/csv-import-operation.test.js',
    ['owns lifecycle, write, cache, and lock ordering', 'maps unexpected parser failures'],
  ],
  [
    'src/services/import/HistoricalGmailImportService.ts',
    'test/historical-gmail-import-operation.test.js',
    ['reports the shared busy code', 'releases its lock when orchestration throws unexpectedly'],
  ],
  [
    'src/services/data/ReceiptRepository.ts',
    'test/metric-regressions.test.js',
    [
      'incremental Gmail upsert distinguishes new, updated, and unchanged orders',
      'export replacement is scoped to its provider and preserves newer matching Gmail orders',
    ],
  ],
  [
    'src/services/data/ImportPreferencesQueryRepository.ts',
    'test/import-preferences-repositories.test.js',
    ["['enum'", "['timestamp'"],
  ],
  [
    'src/contracts/contractFixtures.ts',
    'test/contract-fixtures.test.js',
    ['shared auth fixture', 'canonical error fixture'],
  ],
];

const failures = [];
for (const [source, testFile, behaviors] of cases) {
  const sourcePath = path.join(root, source);
  const testPath = path.join(root, testFile);
  if (!fs.existsSync(sourcePath)) failures.push(`Missing covered source: ${source}`);
  if (!fs.existsSync(testPath)) {
    failures.push(`Missing behavioral test: ${testFile}`);
    continue;
  }
  const text = fs.readFileSync(testPath, 'utf8');
  for (const behavior of behaviors) {
    if (!text.includes(behavior)) failures.push(`${testFile} is missing behavior: ${behavior}`);
  }
}

if (failures.length > 0) {
  console.error(
    `Core behavioral coverage gate failed:\n${failures.map((value) => `- ${value}`).join('\n')}`,
  );
  process.exitCode = 1;
} else {
  console.log(`Core behavioral coverage gate passed (${cases.length} changed modules).`);
}
