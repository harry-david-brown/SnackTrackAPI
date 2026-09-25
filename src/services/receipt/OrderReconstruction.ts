import type { ItemEvidence, ItemPriceResolution } from '../../models/ReceiptResolution';
import type { ReceiptItem } from '../../models/Receipt';
import { moneySum } from '../../models/ReceiptResolution';

export interface ExportItemRow {
  Item_Name: string; Item_quantity: string; Item_Price: string;
  Customizations: string; Customization_Cost_Local: string;
}
const clean = (value: string): string => value.toLowerCase().replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim();
const selections = (value: string): string[] => value.split(',').map(v => v.trim()).filter(Boolean);
const cost = (value: string): number => {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
};
const role = (value: string): string | undefined => {
  if (/^(?:Juice\/Milk\/Water|Drink|Side Item)$/i.test(value)) return undefined;
  if (/hash browns?|fries/i.test(value)) return 'side';
  if (/water|coffee|juice|coke|sprite|tea|fanta|drink/i.test(value)) return 'drink';
  return undefined;
};

/** A repeated signature is only a candidate. Identical selections remain separate purchases. */
type PriceResolver = (row: ExportItemRow) => ItemPriceResolution;
const inferredLinePrice = (row: ExportItemRow): ItemPriceResolution => {
  const recordedAmount = Number(row.Item_Price);
  const quantity = Number(row.Item_quantity || 1);
  return { status: 'line_inferred', recordedAmount, unitAmount: recordedAmount / quantity, lineAmount: recordedAmount, reasons: ['legacy_line_interpretation'] };
};
const forcedPrice = (basis: 'unit' | 'line'): PriceResolver => (row) => {
  const recordedAmount = Number(row.Item_Price);
  const quantity = Number(row.Item_quantity || 1);
  return basis === 'unit'
    ? { status: 'unit_inferred', recordedAmount, unitAmount: recordedAmount, lineAmount: moneySum([recordedAmount * quantity]), reasons: ['subtotal_candidate'] }
    : { status: 'line_inferred', recordedAmount, unitAmount: recordedAmount / quantity, lineAmount: recordedAmount, reasons: ['subtotal_candidate'] };
};
const isAmbiguous = (resolution: ItemPriceResolution): resolution is Extract<ItemPriceResolution, { status: 'ambiguous' }> => resolution.status === 'ambiguous';

export function reconstructUberItems(
  rows: readonly ExportItemRow[],
  expectedSubtotal?: number,
  preserveRows = false,
  customizationBasis: 'per_item' | 'per_line' = 'per_item',
  priceResolver: PriceResolver = inferredLinePrice,
): ReceiptItem[] {
  const groups = new Map<string, { row: ExportItemRow; index: number }[]>();
  rows.forEach((row, index) => {
    const key = JSON.stringify([clean(row.Item_Name), row.Item_quantity, row.Item_Price]);
    groups.set(key, [...(groups.get(key) ?? []), { row, index }]);
  });
  const result: ReceiptItem[] = [];
  const candidatesByGroup: ReceiptItem[][][] = [];
  for (const entries of [...groups.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([,entries]) => entries)) {
    const startIndex = result.length;
    // Only complementary, nonempty, distinct groups qualify. Conflicting side/drink selections
    // indicate separate meals. A zero-cost ingredient group anchors the split-row convention.
    const selectionGroups = new Map<string, typeof entries>();
    for (const entry of entries) {
      const signature = JSON.stringify([clean(entry.row.Customizations),cost(entry.row.Customization_Cost_Local)]);
      selectionGroups.set(signature,[...(selectionGroups.get(signature) ?? []),entry]);
    }
    const distinct = [...selectionGroups.values()].sort((a,b) => clean(a[0].row.Customizations).localeCompare(clean(b[0].row.Customizations)));
    const representatives = distinct.map(group => group[0]);
    const multiplicity = distinct[0].length;
    const roles = representatives.map(({ row }) => new Set(selections(row.Customizations).map(role).filter(Boolean)));
    const conflicting = roles.some((a, i) => roles.some((b, j) => i < j && [...a].some(r => b.has(r))));
    const canCombine = !preserveRows && distinct.length > 1 && representatives.every(e => clean(e.row.Customizations)) &&
      distinct.every(group => group.length === multiplicity) && !conflicting &&
      representatives.some(({ row }) => cost(row.Customization_Cost_Local) === 0) &&
      representatives.some(({ row }) => cost(row.Customization_Cost_Local) !== 0);
    // Repeated complete customization sets represent repeated meals, not one meal.
    const partitions = canCombine ? Array.from({length:multiplicity},(_,index) => distinct.map(group => group[index])) : entries.map(entry => [entry]);
    for (const partition of partitions) {
      const row = partition[0].row;
      // Match CSV validation and contextual pricing: an omitted quantity means one.
      const quantity = Number(row.Item_quantity || 1);
      const base = Number(row.Item_Price);
      const sourcePrice = priceResolver(row);
      const modifiers = moneySum(partition.map(({ row: r }) => cost(r.Customization_Cost_Local) * (customizationBasis === 'per_item' ? quantity : 1)));
      const baseLineTotal = isAmbiguous(sourcePrice) ? base : sourcePrice.lineAmount;
      const configured = isAmbiguous(sourcePrice) ? base : moneySum([baseLineTotal, modifiers]);
      const customizations = [...new Set(partition.flatMap(({ row: r }) => selections(r.Customizations)))].sort();
      const baseProduct = clean(row.Item_Name).replace(/^(?:small|sm|medium|med|large|lrg)\s+/, '');
      const sizedSelection = customizations.map(clean).map(value => value.match(/^(small|sm|medium|med|large|lrg)\s+(.+)$/)).find(match => match?.[2] === baseProduct);
      const sizeName = sizedSelection ? ({small:'Small',sm:'Small',medium:'Medium',med:'Medium',large:'Large',lrg:'Large'}[sizedSelection[1]] ?? sizedSelection[1]) : undefined;
      const configuredName = sizeName ? `${sizeName} ${row.Item_Name.replace(/^(?:small|sm|medium|med|large|lrg)\s+/i,'').replace(/\s*\[.*$/,'')}` : row.Item_Name;
      const modifierGroups = partition.map(({row:r}) => ({labels:selections(r.Customizations),amount:cost(r.Customization_Cost_Local)}));
      const typedModifiers: NonNullable<ItemEvidence['modifiers']> = modifierGroups.flatMap((group,index) => group.labels.map(label => ({label,group:index,
        kind: /^(?:no|remove|without)\b/i.test(label) ? 'removal' as const : /^(?:add|extra)\b/i.test(label) ? 'addition' as const : /^(?:replace|substitute|instead)\b/i.test(label) ? 'substitution' as const : /^(?:small|sm|medium|med|large|lrg)\b/i.test(label) ? 'size' as const : /^(?:Juice\/Milk\/Water|Drink|Side Item)$/i.test(label) ? 'selection' as const : 'unknown' as const })));
      const components: { name: string; quantity: number; role: 'side' | 'drink' }[] = [];
      if (/meal|combo/i.test(row.Item_Name)) {
        for (const selection of customizations) {
          const hash = selection.match(/^(\d+)\s+hash\s*browns?\b/i);
          if (hash) components.push({ name: 'Hash Brown', quantity: quantity * Number(hash[1]), role: 'side' });
          else if (/^(?:small|medium|large|sm|med|lrg)?\s*fries\b/i.test(selection))
            components.push({ name: selection.replace(/\s*\[.*$/, ''), quantity, role: 'side' });
          else if (/^Dasani Water\b/i.test(selection)) components.push({ name: 'Dasani Water', quantity, role: 'drink' });
        }
      }
      const priceResolution: ItemPriceResolution = isAmbiguous(sourcePrice)
        ? sourcePrice
        : { ...sourcePrice, unitAmount: Math.max(0, configured) / quantity, lineAmount: configured };
      result.push({ name: configuredName, quantity, price: isAmbiguous(priceResolution) ? 0 : priceResolution.unitAmount, customizations,
        evidence: { priceResolution, customizationPriceBasis: customizationBasis === 'per_item' ? 'per_item_assumed' : 'per_line_assumed', priceBasis: isAmbiguous(priceResolution) ? 'ambiguous' : priceResolution.status.startsWith('unit_') ? 'unit_assumed' : 'line_assumed', modifierGroups, modifiers: typedModifiers, rawName: row.Item_Name, configuredName, baseLineTotal,
          configuredLineTotal: configured, modifierTotal: modifiers,
          method: canCombine ? 'complementary_modifiers' : entries.length > 1 ? 'preserved_ambiguous' : 'observed',
          sourceRows: partition.map(e => e.index),
          alternatives: entries.length > 1 ? [canCombine ? `${entries.length} separate purchased lines` : 'Repeated customization rows may represent fewer purchased lines'] : [],
          components } });
    }
    const primary = result.slice(startIndex);
    // An unresolved contextual interpretation is not a third price convention. When a
    // trustworthy subtotal exists, compare only concrete unit/line reconstructions.
    const options =
      expectedSubtotal !== undefined &&
      primary.some((item) => isAmbiguous(item.evidence!.priceResolution!))
        ? []
        : [primary];
    if (expectedSubtotal !== undefined && !preserveRows) {
      const mapRows = (items: ReceiptItem[]) => items.map(item => ({ ...item, evidence: { ...item.evidence!, sourceRows: item.evidence!.sourceRows.map(i => entries[i].index) } }));
      for (const basis of ['unit', 'line'] as const)
        for (const modifierBasis of ['per_item', 'per_line'] as const) {
          options.push(mapRows(reconstructUberItems(entries.map(e => e.row), undefined, false, modifierBasis, forcedPrice(basis))));
          if (canCombine) options.push(mapRows(reconstructUberItems(entries.map(e => e.row), undefined, true, modifierBasis, forcedPrice(basis))));
        }
    }
    candidatesByGroup.push(options);
  }
  let selected = result;
  if (expectedSubtotal !== undefined && !preserveRows) {
    const total = (items: ReceiptItem[]) => moneySum(items.map(i => i.evidence!.configuredLineTotal));
    let beam: ReceiptItem[][] = [[]];
    for (let index = 0; index < candidatesByGroup.length; index++) {
      const remaining = candidatesByGroup.slice(index + 1);
      const minimumRemaining = moneySum(remaining.map(options => Math.min(...options.map(total))));
      const maximumRemaining = moneySum(remaining.map(options => Math.max(...options.map(total))));
      const distance = (items: ReceiptItem[]) => Math.max(0,total(items)+minimumRemaining-expectedSubtotal,expectedSubtotal-total(items)-maximumRemaining);
      beam = beam.flatMap(prefix => candidatesByGroup[index].map(option => [...prefix,...option]))
        .sort((a,b) => distance(a)-distance(b) || b.length-a.length || JSON.stringify(a.map(i=>[i.name,i.quantity,i.price,i.customizations])).localeCompare(JSON.stringify(b.map(i=>[i.name,i.quantity,i.price,i.customizations])))).slice(0,64);
    }
    const ordered = beam.sort((a,b) => Math.abs(total(a)-expectedSubtotal)-Math.abs(total(b)-expectedSubtotal) || b.length-a.length);
    selected = ordered[0] ?? result;
    const exact = ordered.filter(items => Math.abs(total(items) - expectedSubtotal) <= 0.01);
    const exactPrices = new Set(exact.map(items => JSON.stringify(items.map(item => [item.name,item.quantity,item.price,item.customizations]))));
    if (exactPrices.size > 1) selected = selected.map(item => ({ ...item, price: 0, evidence: { ...item.evidence!, priceBasis: 'ambiguous', priceResolution: { status: 'ambiguous', recordedAmount: item.evidence!.priceResolution?.recordedAmount ?? item.evidence!.baseLineTotal, reasons: ['multiple_subtotal_interpretations'] } } }));
  }
  if (expectedSubtotal !== undefined && selected.every(item => !isAmbiguous(item.evidence!.priceResolution!)) && Math.abs(moneySum(selected.map(i => i.evidence!.configuredLineTotal)) - expectedSubtotal) <= 0.01)
    selected.forEach(item => {
      const resolution = item.evidence!.priceResolution!;
      if (isAmbiguous(resolution)) return;
      const unit = resolution.status.startsWith('unit_');
      item.evidence!.priceBasis = unit ? 'unit_reconciled' : 'line_reconciled';
      item.evidence!.priceResolution = { ...resolution, status: unit ? 'unit_reconciled' : 'line_reconciled', reasons: [...resolution.reasons, 'receipt_subtotal_match'] };
      item.evidence!.customizationPriceBasis = item.evidence!.customizationPriceBasis === 'per_line_assumed' ? 'per_line_reconciled' : 'per_item_reconciled';
    });
  return selected.sort((a, b) => JSON.stringify([a.name, a.quantity, a.customizations]).localeCompare(JSON.stringify([b.name, b.quantity, b.customizations])));
}
