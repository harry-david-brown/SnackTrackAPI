import { DatabaseError } from '../../core/errors';

type UnknownRecord = Record<string, unknown>;

export interface ParsedQueryPlan {
  readonly rawPlan: UnknownRecord;
  readonly root: UnknownRecord;
  readonly planningTimeMs: number;
  readonly executionTimeMs: number;
  readonly rowsReturned: number;
  readonly nodeType: string | null;
  readonly indexUsed: boolean;
  readonly indexName: string | null;
  readonly ginItemsIndexUsed: boolean;
}

const record = (value: unknown, field: string): UnknownRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DatabaseError(`Invalid query plan field: ${field}`);
  }
  return value as UnknownRecord;
};

const finiteNumber = (value: unknown, field: string): number => {
  const parsed = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new DatabaseError(`Invalid query plan number: ${field}`);
  }
  return parsed;
};

const childPlans = (node: UnknownRecord): UnknownRecord[] => {
  if (node.Plans === undefined) return [];
  if (!Array.isArray(node.Plans)) throw new DatabaseError('Invalid query plan field: Plans');
  return node.Plans.map((child, index) => record(child, `Plans[${index}]`));
};

const nodes = (root: UnknownRecord): UnknownRecord[] => {
  const flattened: UnknownRecord[] = [];
  const visit = (node: UnknownRecord): void => {
    flattened.push(node);
    childPlans(node).forEach(visit);
  };
  visit(root);
  return flattened;
};

const stringField = (
  recordValue: UnknownRecord,
  primary: string,
  fallback?: string,
): string | null => {
  const value = recordValue[primary] ?? (fallback ? recordValue[fallback] : undefined);
  return typeof value === 'string' ? value : null;
};

export const parseQueryPlanRow = (value: unknown): ParsedQueryPlan => {
  const row = record(value, 'row');
  const firstKey = Object.keys(row)[0];
  const fallback = firstKey === undefined ? undefined : row[firstKey];
  const candidate: unknown = row['QUERY PLAN'] ?? row['query plan'] ?? fallback;
  const planValue: unknown = Array.isArray(candidate) ? (candidate as unknown[])[0] : candidate;
  const rawPlan = record(planValue, 'query plan');
  const root = record(rawPlan.Plan, 'query plan.Plan');
  const allNodes = nodes(root);
  const indexNodes = allNodes.filter((node) => {
    const nodeType = stringField(node, 'Node Type', 'Node_Type');
    return (
      nodeType === 'Index Scan' ||
      nodeType === 'Index Only Scan' ||
      nodeType === 'Bitmap Index Scan' ||
      nodeType === 'Bitmap Heap Scan'
    );
  });
  const indexName =
    allNodes
      .map((node) => stringField(node, 'Index Name', 'Index_Name'))
      .find((name): name is string => Boolean(name)) ?? null;

  return {
    rawPlan,
    root,
    planningTimeMs: finiteNumber(rawPlan['Planning Time'], 'Planning Time'),
    executionTimeMs: finiteNumber(rawPlan['Execution Time'], 'Execution Time'),
    rowsReturned: finiteNumber(root['Actual Rows'], 'Plan.Actual Rows'),
    nodeType: stringField(root, 'Node Type', 'Node_Type'),
    indexUsed: indexNodes.length > 0,
    indexName,
    ginItemsIndexUsed: allNodes.some(
      (node) => stringField(node, 'Index Name', 'Index_Name')?.includes('items_gin') ?? false,
    ),
  };
};
