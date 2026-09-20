const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Receipt, DataSource, ReceiptType } = require('../dist/models/Receipt');
const { decodeResolution, moneySum } = require('../dist/models/ReceiptResolution');
const { reconstructUberItems } = require('../dist/services/receipt/OrderReconstruction');
const { resolveObservations } = require('../dist/services/receipt/ReceiptResolutionService');
const { sameOrder } = require('../dist/services/receipt/ReceiptObservationMatching');
const { decodeReceiptObservation } = require('../dist/services/data/receiptObservationCodec');
const { ReceiptDataExtractor } = require('../dist/services/extraction/ReceiptDataExtractor');
const { decodeExtractionResult } = require('../dist/services/extraction/ExtractionResultDecoder');
const { mapReceiptResponse } = require('../dist/http/mappers/receiptResponse');
const cases = require('./fixtures/receipt-accuracy/checkout-orders.json');

function pair(c = cases[3], { subtotal = true, tip = true } = {}) {
  const date = new Date('2025-08-06T13:48:56Z');
  const exported = new Receipt('user',reconstructUberItems(c.rows),c.exportTotal,ReceiptType.UBER_EATS,'Example (Branch)',date,DataSource.CSV,new Date('2025-08-06T14:20:00Z'),undefined,undefined,{currencyCode:'CAD'});
  exported.resolution = {version:1,amountBasis:'export_total',exportedTotal:c.exportTotal,reconstructedSubtotal:moneySum(exported.items.map(i=>i.evidence.configuredLineTotal)),rows:c.rows,adjustments:[],issues:[]};
  const email = new Receipt('user',[],c.emailTotal,ReceiptType.UBER_EATS,exported.restaurantName,date,DataSource.EMAIL,undefined,undefined,undefined,{currencyCode:'CAD',...(subtotal?{subtotal:c.receiptSubtotal}:{}),...(tip?{tip:c.tip}:{})});
  email.resolution = {version:1,amountBasis:'receipt_total',receiptTotal:c.emailTotal,sourceMessageId:'gmail:original',sourceRevisionAt:'2025-08-06T14:21:00Z',adjustments:[],issues:[]};
  return {exported,email};
}

for(const c of cases) test(`checkout evidence: ${c.name}`,()=>{
  const {exported,email}=pair(c);
  assert.equal(sameOrder(exported,email),true);
  const result=resolveObservations([exported,email],'order');
  assert.deepEqual(result,resolveObservations([email,exported],'order'));
  assert.deepEqual(result.resolution.sources,['csv','email']);
  assert.equal(result.amountSpent,c.emailTotal);
  assert.equal(result.resolution.checkoutDifference.exportSubtotal,c.expectedExportSubtotal);
  assert.equal(result.resolution.checkoutDifference.amount,moneySum([c.emailTotal,-c.expectedExportSubtotal]));
  assert.equal(result.resolution.checkoutDifference.subtotalBasis,c.name==='pizza-incomplete-price'?'reconstructed':'receipt_reconciled');
  assert.deepEqual(JSON.parse(JSON.stringify(decodeReceiptObservation(JSON.parse(JSON.stringify(result)),'order'))),JSON.parse(JSON.stringify(result)));
  assert.deepEqual(mapReceiptResponse(result).checkoutDifference,result.resolution.checkoutDifference);
});

test('total-only email matches using bounded evidence without inventing a tip',()=>{
  const {exported,email}=pair(cases[3],{subtotal:false,tip:false});
  assert.equal(sameOrder(exported,email),true);
  email.orderDate=exported.deliveryTime;
  assert.equal(sameOrder(exported,email),true);
  const result=resolveObservations([email,exported]);
  assert.equal(result.monetaryDetails.tip,undefined);
  assert.equal(result.resolution.checkoutDifference.subtotalBasis,'reconstructed');
  assert.equal(result.resolution.checkoutDifference.amount,5.99);
  email.orderDate=new Date('2025-08-07T13:48:56Z');
  assert.equal(sameOrder(exported,email),false);
});

test('revised lower email total wins by chronology and updates the difference',()=>{
  const {exported,email}=pair();
  email.externalId='provider-order';
  const revised=decodeReceiptObservation(JSON.parse(JSON.stringify(email)));
  revised.amountSpent=18;
  revised.resolution.receiptTotal=18;
  revised.resolution.sourceMessageId='gmail:revised';
  revised.resolution.sourceRevisionAt='2025-08-07T12:00:00Z';
  const a=resolveObservations([exported,email,revised]);
  assert.deepEqual(a,resolveObservations([revised,exported,email]));
  assert.equal(a.amountSpent,18);
  assert.equal(a.resolution.checkoutDifference.amount,2.13);
  assert.equal(a.resolution.checkoutDifference.emailSourceMessageId,'gmail:revised');
});

test('negative, zero and unavailable are distinct; one source has no comparison',()=>{
  const {exported,email}=pair(cases[7]);
  assert.equal(resolveObservations([email,exported]).resolution.checkoutDifference.amount,-8.56);
  email.amountSpent=38.47;
  assert.equal(resolveObservations([email,exported]).resolution.checkoutDifference.amount,0);
  email.monetaryDetails.currencyCode='UNKNOWN';
  const unknown=resolveObservations([email,exported]).resolution.checkoutDifference;
  assert.equal(unknown.status,'unavailable'); assert.equal(unknown.amount,null);
  assert.equal(unknown.reason,'unknown_currency');
  email.monetaryDetails.currencyCode='USD';
  assert.equal(resolveObservations([email,exported]).resolution.checkoutDifference.reason,'currency_conflict');
  exported.items=[]; exported.resolution.rows=undefined; exported.resolution.reconstructedSubtotal=undefined;
  email.monetaryDetails.currencyCode='CAD';
  assert.equal(resolveObservations([email,exported]).resolution.checkoutDifference.reason,'missing_export_subtotal');
  assert.equal(resolveObservations([email]).resolution.checkoutDifference,undefined);
  assert.equal(resolveObservations([exported]).resolution.checkoutDifference,undefined);
});

test('DoorDash subtotal is not used as a final charge; explicit subtotal can match',()=>{
  const {exported,email}=pair();
  exported.receiptType=email.receiptType=ReceiptType.DOORDASH;
  exported.resolution.amountBasis='item_subtotal';
  exported.resolution.rows=[];
  assert.equal(sameOrder(exported,email),true);
  delete email.monetaryDetails.subtotal;
  assert.equal(sameOrder(exported,email),false);
});

test('provider/user identity, branch and conflicting order IDs protect real purchases',()=>{
  const {exported,email}=pair();
  email.restaurantName='Example (Other Branch)'; assert.equal(sameOrder(exported,email),false);
  email.externalId=exported.externalId='same'; assert.equal(sameOrder(exported,email),true);
  email.externalId='other'; assert.equal(sameOrder(exported,email),false);
  email.externalId='same'; email.userId='another'; assert.equal(sameOrder(exported,email),false);
  email.userId='user'; email.receiptType=ReceiptType.DOORDASH; assert.equal(sameOrder(exported,email),false);
});

test('subtotal reconciliation can choose per-line customization without changing quantity',()=>{
  const row={Item_Name:'Example sandwich',Item_quantity:'2',Item_Price:'10',Customizations:'Extra cheese',Customization_Cost_Local:'1'};
  assert.equal(reconstructUberItems([row])[0].evidence.configuredLineTotal,12);
  const item=reconstructUberItems([row],11)[0];
  assert.equal(item.quantity,2);
  assert.equal(item.evidence.configuredLineTotal,11);
  assert.equal(item.evidence.customizationPriceBasis,'per_line_reconciled');
});

test('adjustments and savings headline survive the actual extraction decoder',()=>{
  const html='<p>Total CA$21.86</p><p>You saved CA$7.66</p><p>Subtotal CA$15.87</p><p>Delivery Discount -CA$5.99</p><p>Membership Benefit -CA$0.79</p>';
  const data=new ReceiptDataExtractor().extract(html,'Uber Eats receipt','noreply@uber.com');
  const result={data,classification:{isReceipt:true,confidence:1,reason:'fixture',matchedKeywords:[],tableWordHits:0},rawText:'fixture',coreText:'fixture'};
  const decoded=decodeExtractionResult(result).data;
  assert.deepEqual(decoded.adjustments,data.adjustments);
  assert.equal(decoded.headlineSavings,7.66);
  assert.throws(()=>decodeExtractionResult({...result,data:{...data,adjustments:[{kind:'invalid',label:'x',amount:1}]}}));
  assert.throws(()=>decodeResolution({version:1,amountBasis:'receipt_total',adjustments:[],issues:[],checkoutDifference:{status:'available',amount:3,emailTotal:10,exportSubtotal:5,currencyCode:'CAD',subtotalBasis:'reconstructed'}}));
});
