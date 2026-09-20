const { test } = require('node:test');
const assert = require('node:assert/strict');
const cases = require('./fixtures/receipt-accuracy/verified-orders.json');
const { reconstructUberItems } = require('../dist/services/receipt/OrderReconstruction');
const { moneySum, reconcileMoney } = require('../dist/models/ReceiptResolution');
const { sameOrder, resolveObservations } = require('../dist/services/receipt/ReceiptResolutionService');
const { classifyItemPersonality } = require('../dist/services/analytics/dashboard/itemPersonalities');
const { Receipt, ReceiptType, DataSource } = require('../dist/models/Receipt');
for (const c of cases) test(`independently checked receipt: ${c.name}`, () => {
  const items = reconstructUberItems(c.rows);
  assert.deepEqual(items.map(i=>i.quantity).sort(), [...c.expectedQuantities].sort());
  assert.equal(moneySum(items.map(i=>i.evidence.configuredLineTotal)),c.subtotal);
  assert.equal(reconcileMoney(c.subtotal,c.charges,c.discounts.map(amount=>({kind:'promotion',label:'observed',amount})),c.receiptTotal),0);
  assert.equal(moneySum([c.receiptTotal,-c.exportTotal,-2]),c.unexplainedAfterTip);
  if(c.name==='breakfast-components') assert.equal(items.reduce((n,i)=>n+(/Hash Brown/.test(i.name)?i.quantity:0)+i.evidence.components.filter(c=>c.name==='Hash Brown').reduce((n,c)=>n+c.quantity,0),0),5);
  const projection = rows => reconstructUberItems(rows).map(({evidence,...i})=>({...i,evidence:{...evidence,sourceRows:[]}}));
  assert.deepEqual(projection(c.rows),projection([...c.rows].reverse()));
});
test('identical meals and explicit promotional quantities survive',()=>{
  const row=cases[1].rows[1];
  assert.equal(reconstructUberItems([row,{...row}]).length,2);
  assert.equal(reconstructUberItems([{...row,Item_quantity:'2',Item_Price:'18.38'}])[0].quantity,2);
});
test('different side selections cannot be collapsed into one meal',()=>{
  const row=cases[1].rows[1];
  assert.equal(reconstructUberItems([row,{...row,Customizations:'Fries',Customization_Cost_Local:'0'}]).length,2);
});
test('source matching is provider scoped and does not merge same-minute orders without evidence',()=>{
  const a=new Receipt('u',[],20,ReceiptType.UBER_EATS,'Shop',new Date('2025-01-01T12:00Z'),DataSource.EMAIL);
  const b=new Receipt('u',[],20,ReceiptType.DOORDASH,'Shop',a.orderDate,DataSource.EMAIL);
  assert.equal(sameOrder(a,b),false);
  b.receiptType=a.receiptType;
  assert.equal(sameOrder(a,b),false);
});
test('email/export permutations preserve items and explicit financial evidence',()=>{
  const a=new Receipt('u',reconstructUberItems(cases[0].rows),31.19,ReceiptType.UBER_EATS,'Shop',new Date('2025-01-01T12:00Z'),DataSource.CSV,undefined,'order');
  a.resolution={version:1,amountBasis:'export_total',exportedTotal:31.19,adjustments:[],issues:[]};
  const b=new Receipt('u',[],33.30,ReceiptType.UBER_EATS,'Shop',a.orderDate,DataSource.EMAIL,undefined,'order',undefined,{tip:2});
  b.resolution={version:1,amountBasis:'receipt_total',receiptTotal:33.30,adjustments:[],issues:[]};
  assert.deepEqual(resolveObservations([a,b]),resolveObservations([b,a]));
  assert.equal(resolveObservations([a,b]).amountSpent,33.30);
  assert.equal(resolveObservations([a,b]).items[0].quantity,2);
});
test('context overrides misleading food keywords',()=>{
  assert.equal(classifyItemPersonality('nugget sauce'),'sauce');
  assert.equal(classifyItemPersonality('pizza sub'),'other');
  assert.equal(classifyItemPersonality('cookie dough blizzard'),'other');
});
test('two complete repeated customization sets resolve to two meals, not one or six',()=>{
 const mealRows=cases[1].rows.slice(1);
 const items=reconstructUberItems([...mealRows,...mealRows]);
 assert.equal(items.length,2);
 assert.equal(items.reduce((n,i)=>n+i.quantity,0),2);
 assert.equal(moneySum(items.map(i=>i.evidence.configuredLineTotal)),23.78);
});
test('explicit subtotal can override the structural merge candidate',()=>{
 const rows=cases[2].rows.filter(r=>r.Item_Name.startsWith('Med'));
 assert.equal(reconstructUberItems(rows,11.98).length,2);
});
const { ReceiptDataExtractor } = require('../dist/services/extraction/ReceiptDataExtractor');
const { extractReceiptAdjustments } = require('../dist/services/extraction/ReceiptAdjustments');
const { buildDashboardDataset } = require('../dist/services/analytics/dashboard/normalization');
const { ReceiptRebuildService } = require('../dist/services/receipt/ReceiptRebuildService');
test('subtotal is not mistaken for final total and headline savings are not another discount',()=>{
 const data=new ReceiptDataExtractor().extract('<p>Subtotal CA$15.47</p><p>Total CA$20.87</p>','Uber Eats receipt','noreply@uber.com');
 assert.equal(data.total,20.87);
 assert.deepEqual(extractReceiptAdjustments('You saved CA$5.38\nMembership Benefit -CA$0.77\nDelivery Discount -CA$3.99').map(a=>a.amount),[-3.99,-0.77]);
});
test('zero-cost orders remain activity; appearances count orders, not item rows',()=>{
 const r=new Receipt('u',[{name:'Fries',quantity:1,price:0},{name:'Fries',quantity:1,price:0}],0,ReceiptType.UBER_EATS,'Shop',new Date('2025-01-01T12:00Z'),DataSource.CSV);
 const dataset=buildDashboardDataset([r],'America/Toronto');
 assert.equal(dataset.dated.length,1);
 assert.equal(dataset.itemTotals.get('fries').appearances,1);
 assert.equal(dataset.itemTotals.get('fries').units,2);
});
test('rebuild cache invalidation follows successful publish, never prepare or failed commit',async()=>{
 let invalidations=0,assertions=0;
 const repository={rebuildProjection:async(user,generation,mode,assert)=>{await assert();if(generation===0)throw Error('stale');return {orders:1,changed:1,legacy:0,mode};}};
 const service=new ReceiptRebuildService(repository,{invalidateAllUserCaches:async()=>{invalidations++;}},{assertLockOwned:async()=>{assertions++;}});
 await service.executeWithLock('u',1,'prepare',{userId:'u'});
 assert.equal(invalidations,0);
 await service.executeWithLock('u',1,'publish',{userId:'u'},'manifest');
 assert.equal(invalidations,1);
 await assert.rejects(service.executeWithLock('u',0,'publish',{userId:'u'},'manifest'));
 assert.equal(invalidations,1);assert.equal(assertions,3);
 await assert.rejects(service.executeWithLock('u',1,'publish',{userId:'other'},'manifest'),/different account/);
 assert.equal(invalidations,1);assert.equal(assertions,3);
});
const { exportAddressCurrency } = require('../dist/services/receipt/ReceiptTimeConvention');
test('address evidence supports currency inference without retaining an address',()=>{
 assert.deepEqual(exportAddressCurrency('Example Road, ON K1A 0B1'),{currencyCode:'CAD',currencyInference:'canadian_postal'});
 assert.deepEqual(exportAddressCurrency('Example Road'),{currencyCode:'UNKNOWN'});
});
test('unrelated tracking UUIDs are not treated as provider order identities',()=>{
 const extractor=new ReceiptDataExtractor();
 const html='<p>Total CA$10.00</p><a href="https://uber.com/promos?uuid=11111111-1111-1111-1111-111111111111">Offer</a>';
 assert.equal(extractor.extract(html,'Uber Eats receipt','noreply@uber.com').orderId,null);
});
