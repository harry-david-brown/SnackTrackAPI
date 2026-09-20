// Synthetic provider-layout fixture using the screenshot's merchant/day/amounts.
// Item name, placement/delivery times and country text are test inputs, not recovered source facts.
const headers = [
  'ITEM',
  'CATEGORY',
  'STORE_NAME',
  'UNIT_PRICE',
  'QUANTITY',
  'SUBTOTAL',
  'CREATED_AT',
  'DELIVERY_TIME',
  'DELIVERY_ADDRESS',
];
const base = {
  ITEM: 'Pizza',
  CATEGORY: 'Pizza',
  STORE_NAME: "Grimaldi's Garden City",
  UNIT_PRICE: '76.80',
  QUANTITY: '1',
  SUBTOTAL: '76.80',
  CREATED_AT: '2026-07-05 12:00:00',
  DELIVERY_TIME: '2026-07-05 12:45:00',
  DELIVERY_ADDRESS: 'Redacted, USA',
};
const csv = (rows = [{}]) =>
  [
    headers.join(','),
    ...rows.map((overrides) =>
      headers
        .map((key) => `"${String({ ...base, ...overrides }[key]).replaceAll('"', '""')}"`)
        .join(','),
    ),
  ].join('\n');
const email = {
  subject: "Order confirmation from Grimaldi's Garden City",
  body: 'DoorDash\nThanks for your order\nJuly 5, 2026\nYour receipt\nTaxes\nTotal Charged\nUS$61.39',
};
module.exports = { csv, base, email };
