import 'dotenv/config';
import { config } from '../config/AppConfig';
import { PostgresService } from '../services/data/PostgresService';
import { GmailCredentialMigrationRepository } from '../services/data/GmailCredentialMigrationRepository';
import { GmailCredentialCipher } from '../services/mailbox/GmailCredentialCipher';
import { MailboxSecretCipher } from '../services/mailbox/MailboxSecretCipher';

const database = new PostgresService({
  connectionString: config.getDatabaseConnectionString(),
  useSsl: config.shouldUseDatabaseSSL(),
  sslCa: config.getDatabaseSslCa(),
  maxConnections: 1,
  minimumConnections: 0,
});
const run = async () => {
  try {
    const repository = new GmailCredentialMigrationRepository(database,
      new GmailCredentialCipher(new MailboxSecretCipher(config.getMicrosoftMailboxConfig().tokenEncryptionKey)));
    let total = 0;
    let count: number;
    do { count = await repository.encryptBatch(); total += count; } while (count > 0);
    console.info('Gmail credential encryption completed', { accountsUpdated: total });
  } catch {
    // Database errors can contain SQL parameters; never print credential-bearing errors.
    console.error('Gmail credential encryption failed. Check database connectivity and the configured encryption key.');
    process.exitCode = 1;
  } finally {
    await database.close();
  }
};
void run();
