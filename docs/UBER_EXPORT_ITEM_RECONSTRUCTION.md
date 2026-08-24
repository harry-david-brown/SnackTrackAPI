# Deferred issue: reconstructing Uber Eats items from flattened exports

Status: deferred for later investigation  
Affected source: `src/services/import/CsvImportService.ts`  
Affected analytics: item counts, most-ordered meals, exact-basket matching,
item obsession, and item-level Foodflation insights

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

New imports now retain each row's customization strings on the stored
`ReceiptItem`. This supplies sauce-ranking analytics with flavour names and
preserves more evidence for future reconstruction, but it does not reconstruct
logical items or repair histories imported before customization retention was
added. Those histories require re-importing the original export to gain the
additional provenance.

## Item Foodflation failure: duplicate modifier rows become a fake price jump

Status: known and deferred with the broader reconstruction work

Item-level Foodflation currently groups observations by normalized restaurant,
item name, and quantity. Within an order, it adds the stored price of every row
with that key. That aggregation is unsafe for Uber exports because repeated
rows may be modifier fragments for one item rather than separately purchased
items.

A manually reviewed McDonald's example produced the following card inputs:

| Order date | Normalized item | Matching CSV rows | Exported item price per row | Current calculated observation |
| --- | --- | ---: | ---: | ---: |
| Sep 14, 2020 | Big Mac Extra Value Meal 710 | 1 | $9.89 | $9.89 |
| Aug 16, 2024 | Big Mac Extra Value Meal 710 | 2 | $14.79 | $29.58 |

The two 2024 rows both have quantity `1` and price `$14.79`, but carry
different customization fragments. One contains the burger and drink choices;
the other contains the fries choice. They are evidence of one configured meal
flattened across two rows, not two meals costing `$29.58`.

The current calculation therefore reports:

```text
Earlier observation = $9.89
Recent observation  = $14.79 + $14.79 = $29.58
Displayed change    = $19.69, or 199% more
```

If one exported base price is used for the recent meal, the comparison becomes:

```text
Earlier observation =  $9.89
Recent observation  = $14.79
Change              =  $4.90, or 49.5% more (displayed as 50%)
```

A second real export independently contains one Big Mac meal repeated across
two `$9.89` rows: one row carries the drink customization and the other carries
the fries customization. This confirms that the failure is a recurring Uber
export shape rather than a one-off corrupt row.

There is an additional matching problem: Foodflation currently discards
customization contents when deciding that two observations are the "same
item." The base menu name may match while the drink, side, size, paid modifier,
or other configuration differs. Even after duplicate rows are reconstructed,
the product must distinguish an identical configured item from the same base
item with different options—or label the latter comparison less strongly.

### Scope of impact

- Item-level Foodflation can show severely inflated recent or earlier prices.
- Its percentage and dollar deltas inherit the inflated observation.
- Its tracked-order sample size can be correct while the compared prices are
  wrong, making the result look better-supported than it is.
- Full-order Foodflation does not sum item rows; it compares the grouped receipt
  totals and is not directly affected by this price-summing bug.
- Full-order basket identity can still be affected when flattened modifier rows
  make logically equivalent baskets normalize differently.

### Required correction when revisited

Do not merely replace the sum with an unconditional deduplication. The future
reconstruction must first decide whether repeated rows represent modifier
fragments or genuinely separate identical items. Item Foodflation should then:

1. build one reconstructed item-price observation per order;
2. preserve explicit quantity and convert unit prices to the intended line
   price exactly once;
3. avoid adding a repeated base price for each customization fragment;
4. include a normalized configuration signature when claiming the item is
   identical, or clearly say it is only the same base menu item;
5. suppress the comparison when multiple interpretations produce materially
   different prices; and
6. retain the original rows so improved reconstruction can recompute historical
   observations without another export upload.

Add a regression fixture for the `$9.89 → $14.79` example and assert that it
never becomes `$9.89 → $29.58`. Add a second fixture where two identical items
were genuinely purchased so the correction does not collapse real quantity.

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
- Add item-level Foodflation coverage for flattened modifier rows, explicit
  quantities, configuration changes, and genuinely duplicated items.

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
