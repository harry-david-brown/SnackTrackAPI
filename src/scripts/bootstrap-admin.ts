import bcrypt from 'bcryptjs';
import { config } from '../config/AppConfig';
import { PostgresService } from '../services/data/PostgresService';
import { AdminRepository } from '../services/admin/AdminRepository';

const args = process.argv.slice(2);
const emailArg = args[0] === '--email' ? args[1] : args[0];
const email = emailArg?.trim().toLowerCase();
if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
  throw new Error('Usage: npm run admin:bootstrap -- --email owner@example.com');
}

const readSecret = (prompt: string): Promise<string> => new Promise((resolve, reject) => {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    reject(new Error('Administrator bootstrap requires an interactive terminal'));
    return;
  }
  let value = '';
  const finish = (error?: Error) => {
    process.stdin.off('data', onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\n');
    if (error) reject(error); else resolve(value);
  };
  const onData = (chunk: Buffer) => {
    const input = chunk.toString('utf8');
    if (input === '\u0003') return finish(new Error('Administrator bootstrap cancelled'));
    if (input === '\r' || input === '\n') return finish();
    if (input === '\u007f') value = value.slice(0, -1);
    else value += input;
  };
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on('data', onData);
});

const postgres = new PostgresService({
  connectionString: config.getDatabaseConnectionString(),
  useSsl: config.shouldUseDatabaseSSL(),
  sslCa: config.getDatabaseSslCa(),
  maxConnections: 1,
});

void (async () => {
  try {
    const password = await readSecret('Owner password: ');
    if (password.length < 12 || !/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
      throw new Error('Admin password must be at least 12 characters with uppercase, lowercase, and a number');
    }
    const owner = await new AdminRepository(postgres).bootstrapOwner(email, await bcrypt.hash(password, 12));
    process.stdout.write(`Created SnackTrack owner ${owner.email}\n`);
  } finally {
    await postgres.close();
  }
})();
