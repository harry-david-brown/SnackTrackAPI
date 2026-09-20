// Minimal, redacted transcription of the six supplied screenshot receipts and
// user_orders-0.csv in the user-supplied Uber data archive. No inferred order IDs.
const headers = [
  'City_Name',
  'Restaurant_Name',
  'Request_Time_Local',
  'Final_Delivery_Time_Local',
  'Order_Status',
  'Item_Name',
  'Item_quantity',
  'Customizations',
  'Customization_Cost_Local',
  'Special_Instructions',
  'Item_Price',
  'Order_Price',
  'Currency',
];
const rows = [
  [
    'Ottawa',
    'Pizza Pizza (1717 Bank St.)',
    '2023-12-10T00:38:23Z',
    '2023-12-10T01:16:23Z',
    'completed',
    'Medium',
    '1',
    'New York Style Pepperoni',
    '2.40',
    '',
    '11.69',
    '0.00',
    'CAD',
  ],
  [
    'Ottawa',
    'Pizza Pizza (1717 Bank St.)',
    '2023-12-10T01:20:36Z',
    '2023-12-10T01:21:21Z',
    'canceled',
    'Medium',
    '1',
    'Dairy-Free Cheeze, SIX CHEESE BASE',
    '1.65',
    '',
    '11.69',
    '43.26',
    'CAD',
  ],
  [
    'Ottawa',
    'Pizza Pizza (1717 Bank St.)',
    '2023-12-10T01:47:32Z',
    '2023-12-10T02:17:10Z',
    'completed',
    'Small',
    '1',
    'WELL DONE',
    '0.00',
    '',
    '9.39',
    '19.47',
    'CAD',
  ],
  [
    'Ottawa',
    'Metro (2515 Bank Street Ottawa )',
    '2023-12-10T13:06:27Z',
    '2023-12-10T13:56:31Z',
    'completed',
    'Milk',
    '3',
    '',
    '0.00',
    '',
    '6.49',
    '48.46',
    'CAD',
  ],
  [
    'Ottawa',
    'McDonald’s (Cahill & Dazé)',
    '2023-12-10T13:39:24Z',
    '2023-12-10T13:56:08Z',
    'completed',
    'Wrap',
    '1',
    '',
    '0.00',
    '',
    '8.79',
    '45.83',
    'CAD',
  ],
];
const csv = [headers, ...rows]
  .map((row) => row.map((v) => `"${v.replace(/"/g, '""')}"`).join(','))
  .join('\n');
const emails = [
  {
    id: 'pizza-original',
    merchant: rows[0][1],
    total: 22.48,
    text: `Uber Eats
Total CA$22.48
December 10, 2023
Thanks for being an Uber One member
Here's your receipt from Pizza Pizza (1717 Bank St.) and Uber Eats.
Total CA$22.48
You saved CA$3.21 on this order with Uber One and promos
Payments
Visa ••••5028 CA$22.48
12/10/23 1:44 AM
Switch Payment Method
Delivered by COURIER A`,
  },
  {
    id: 'pizza-refund',
    merchant: rows[0][1],
    total: 0,
    text: `Uber Eats
Total CA$0.00
December 10, 2023
Thanks for ordering
We updated your receipt for Pizza Pizza (1717 Bank St.).
Total CA$0.00
Your refund has been applied.
Previous Total CA$22.48
New Total CA$0.00
Payments
Visa ••••5028 CA$22.48
12/10/23 1:44 AM
Uber Cash -CA$22.48
12/10/23 1:44 AM
Refund
Switch Payment Method
Delivered by COURIER A`,
  },
  {
    id: 'pizza-small',
    merchant: rows[0][1],
    total: 19.47,
    text: `Uber Eats
Total CA$19.47
December 10, 2023
Thanks for being an Uber One member
Here's your receipt from Pizza Pizza (1717 Bank St.) and Uber Eats.
Total CA$19.47
You saved CA$3.05 on this order with Uber One and promos
Payments
Uber Cash CA$19.47
12/10/23 2:17 AM
Switch Payment Method
Delivered by COURIER B`,
  },
  {
    id: 'pizza-canceled',
    merchant: rows[0][1],
    total: 43.26,
    text: `Uber Eats
Cancellation Fee CA$43.26
December 10, 2023
Your order has been canceled
Here's your receipt from Pizza Pizza (1717 Bank St.) and Uber Eats.
Total CA$43.26
Pizza Pizza (1717 Bank St.) had already started your order, so you were charged for the food.
Payments
Visa ••••5028 CA$43.26
12/10/23 12:20 PM
Switch Payment Method`,
  },
  {
    id: 'metro',
    merchant: rows[3][1],
    total: 48.46,
    text: `Uber Eats
Total CA$48.46
December 10, 2023
Thanks for being an Uber One member
Here's your receipt for Metro (2515 Bank Street Ottawa ).
Total CA$48.46
Payments
Visa ••••5028 CA$48.46
12/11/23 12:06 AM
Switch Payment Method
Delivered by COURIER C`,
  },
  {
    id: 'mcdonalds',
    merchant: rows[4][1],
    total: 45.83,
    text: `Uber Eats
Total CA$45.83
December 10, 2023
Thanks for being an Uber One member
Here's your receipt from McDonald's (Cahill & Dazé) and Uber Eats.
Total CA$45.83
Payments
Uber Cash CA$6.22
12/10/23 1:56 PM
Visa ••••5028 CA$39.61
12/11/23 12:39 AM
Switch Payment Method
Delivered by COURIER D`,
  },
];
module.exports = { csv, emails, headers, rows };
