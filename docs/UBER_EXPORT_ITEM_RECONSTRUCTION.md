# Deferred issue: reconstructing Uber Eats items from flattened exports

Status: deferred for later investigation  
Affected source: `src/services/import/CsvImportService.ts`  
Affected analytics: item counts, most-ordered meals, exact-basket matching, and future item-obsession insights

## Summary

Uber's `user_orders-0.csv` can contain multiple rows with the same item name,
quantity, and price inside one order, where each row carries different
customization text. These rows may represent either:

1. one logical item whose modifier groups were flattened into separate CSV
   rows; or
2. multiple genuinely separate copies of the same item.

The export does not include the item `instance_id` or modifier-group identifiers
available in Uber's order model, so the two cases cannot always be distinguished
structurally.

SnackTrack currently converts every CSV row into a `ReceiptItem`. This can
overcount items and distort item-level analytics.

Do not implement blanket row deduplication. It would fix some flattened
customization records while incorrectly merging legitimate identical items.

## Observed example

One completed Starbucks order in a real Uber export contains these four rows:

| Item | Quantity | Item price | Customization cost | Customizations |
| --- | ---: | ---: | ---: | --- |
| Chocolate Chunk Cookie | 1 | $4.25 | $0.00 | Not Warmed, Warmed |
| Mocha Frappuccino Blended Beverage | 1 | $7.35 | $0.80 | Venti Mocha Frappuccino |
| Mocha Frappuccino Blended Beverage | 1 | $7.35 | $0.00 | Whole Milk, Whipped Cream, Included Frappuccino Roast, Included Mocha Sauce |
| Mocha Frappuccino Blended Beverage | 1 | $7.35 | $3.30 | Shots |

All rows have the same request time, delivery time, restaurant, and final order
total of $19.68.

The matching timestamps establish only that the rows belong to the same order.
They are not evidence that repeated rows represent the same item, because all
items in an order share those timestamps.

## Price-reconciliation evidence

Treating the three Frappuccino rows as three separate drinks produces this
minimum subtotal:

```text
3 x $7.35 Frappuccinos = $22.05
1 x $4.25 cookie       =  $4.25
--------------------------------
Item prices alone      = $26.30
Final order total      = $19.68
```

That interpretation exceeds the entire order total before the $4.10 in listed
customization charges.

Treating the repeated rows as one drink produces:

```text
1 x $7.35 Frappuccino  =  $7.35
1 x $4.25 cookie       =  $4.25
Customization charges =  $4.10
--------------------------------
Known item charges     = $15.70
Final order total      = $19.68
Unexplained difference =  $3.98
```

The second interpretation is substantially more plausible because the remaining
difference can accommodate taxes and fees.

It is still not mathematical proof. Uber states that promotional-discount
details may be excluded from personal data downloads, so pre-discount item
prices can legitimately exceed the final order total.

## Current behavior

`CsvImportService.convertUberEatsRowsToReceipts` groups CSV rows into an order by
restaurant and request time, then maps every row directly to a `ReceiptItem`.
For the example above, SnackTrack stores three Frappuccino items instead of the
more plausible single customized drink.

Consequences include:

- inflated most-ordered-item counts;
- unreliable physical-unit estimates such as cookies or hash browns;
- false exact-basket matches;
- incorrect average basket sizes; and
- misleading item-based dashboard and Wrapped copy.

Order totals and receipt-level spending are not inflated by this behavior
because SnackTrack uses one order total per grouped receipt.

## Required future approach

Item reconstruction should be a separate, tested normalization step rather than
a simple duplicate filter. It should:

1. use timestamps only to identify the containing order;
2. generate competing interpretations for repeated rows;
3. consider item name, quantity, item price, customization cost, and
   customization contents;
4. reconcile each interpretation against the final order total;
5. account for plausible taxes, service fees, delivery fees, and undocumented
   promotions;
6. preserve genuinely separate identical items when the evidence supports them;
7. retain the raw rows or sufficient provenance for later reprocessing; and
8. produce a confidence level or suppress quantity-based insights when the
   interpretations remain materially ambiguous.

A best-fit interpretation may be suitable for SnackTrack's deliberately playful
analytics, but it must include sanity checks to avoid extreme overcounts.

## Item-obsession product decision

The desired user-facing metric is an estimated physical quantity, such as:

> You ordered roughly 200 hash browns.

This is preferred over "hash browns appeared in 68 orders." The estimate does
not need perfect forensic accuracy, but the reconstruction must first handle:

- repeated customization rows;
- explicit item quantities;
- quantities embedded in names such as `12-Pack Cookies` or `10 McNuggets`;
- clearly named items included in meal customizations; and
- aliases, calorie suffixes, and renamed menu items.

Copy should say the user "ordered" or that orders "included" the estimated
quantity, not claim the user personally ate every unit.

## Acceptance criteria for revisiting

- Add fixtures covering one item split across modifier rows.
- Add fixtures covering two genuinely separate identical items.
- Add fixtures for included meal components plus separately purchased sides.
- Add fixtures involving promotions where item totals exceed the paid total.
- Demonstrate reconstruction against multiple merchants, not only Starbucks.
- Compare normalized counts with manually reviewed samples from both available
  Uber exports.
- Update or recompute existing imported receipt items if normalization moves
  into the ingestion path.
- Add regression coverage for `most-ordered-meal` and future item-obsession
  insights.

## External references

- Uber's personal-data documentation says Eats downloads include ordered items,
  customizations, and special instructions, while some promotional details are
  excluded:
  <https://help.uber.com/en-GB/ubereats/restaurants/article/whats-in-your-uber-data-download?nodeId=1a6b5981-3a7b-4fd8-a112-7566116ed955>
- Uber's order API models a cart item with an `instance_id` and nested
  `selected_modifier_groups`; those identifiers are absent from the personal
  CSV:
  <https://developer.uber.com/docs/eats/references/api/v2/get-eats-order-orderid>
- Uber's menu-integration documentation describes `bundled_items`, including
  components such as fries included in a combo:
  <https://developer.uber.com/docs/eats/guides/menu-integration>

