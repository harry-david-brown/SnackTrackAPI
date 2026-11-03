import type { DatabaseQueryExecutor } from '../ports/DatabasePort';

/** Bound statement size while keeping all writes on the caller's transaction. */
export async function writeDatabaseBatches(
  tx: DatabaseQueryExecutor,
  rows: readonly (readonly unknown[])[],
  statement: (parameters: string[][]) => string,
): Promise<void> {
  for (let offset = 0; offset < rows.length; offset += 100) {
    const values: unknown[] = [];
    const parameters = rows.slice(offset, offset + 100).map((row) => row.map((value) => {
      values.push(value);
      return `$${values.length}`;
    }));
    await tx.query(statement(parameters), values);
  }
}
