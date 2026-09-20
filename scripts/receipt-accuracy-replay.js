#!/usr/bin/env node
/** Read-only local replay. No database, mailbox, or account access. */
const fs = require('node:fs/promises');
const { CsvImportService } = require('../dist/services/import/CsvImportService');
const { ZipExtractor } = require('../dist/services/import/ZipExtractor');
const { buildDashboardDataset } = require('../dist/services/analytics/dashboard/normalization');
const { buildCandidateCatalogue } = require('../dist/services/analytics/dashboard/candidates');
const { WrappedAnalyticsCalculator } = require('../dist/services/analytics/WrappedAnalyticsService');
const { moneySum } = require('../dist/models/ReceiptResolution');
(async()=>{
 const [provider,path,timezone='America/Toronto',baselinePath]=process.argv.slice(2);
 if(!['uber_eats','doordash'].includes(provider)||!path) throw new Error('Usage: node scripts/receipt-accuracy-replay.js <uber_eats|doordash> <archive.zip|orders.csv> [timezone]');
 let extracted;
 try {
  if(path.toLowerCase().endsWith('.zip')) extracted=await new ZipExtractor().extractProviderCSVToFile(path,provider);
  const result=await new CsvImportService().parseCsvPathForProvider(extracted?.path??path,provider,'local-audit',timezone);
  const dataset=buildDashboardDataset(result.receipts,timezone);
  const wrapped=await new WrappedAnalyticsCalculator().calculate(result.receipts.map(r=>({...r,id:r.id??'audit',restaurantName:r.restaurantName??null,orderDate:r.orderDate??null,currencyCode:r.monetaryDetails?.currencyCode,timezone:r.resolution?.timestamp?.timezone})),timezone);
  const baseline=baselinePath?JSON.parse(await fs.readFile(baselinePath,'utf8')):null;
  const rawRows=result.receipts.reduce((n,r)=>n+(r.resolution?.rows?.length??r.items.length),0);
  const candidates=buildCandidateCatalogue(dataset).eligible.map(c=>c.insight);
  const priorCandidates=new Map((baseline?.candidates??[]).map(c=>[c.id,c]));
  const candidateChanges=baseline?candidates.filter(c=>JSON.stringify(priorCandidates.get(c.id))!==JSON.stringify(c)).map(c=>({id:c.id,before:priorCandidates.get(c.id)??null,after:c,reason:'Recomputed with resolved quantities, configured prices, explicit currency basis and shared metric definitions; source evidence is included per order.'})):undefined;
  if(candidateChanges) for(const [id,before] of priorCandidates) if(!candidates.some(c=>c.id===id)) candidateChanges.push({id,before,after:null,reason:'No longer eligible under the current metric definitions.'});
  const output={version:1,rawRows,wrapped,candidateChanges,
   baseline:baseline?{orders:baseline.orders??baseline.summary?.receipts,totalsByCurrency:baseline.totalsByCurrency??baseline.summary?.byCurrency}:undefined,orders:result.receipts.length,errors:result.errors,totalsByCurrency:dataset.totalsByCurrency,
   reconstructedLines:result.receipts.reduce((n,r)=>n+r.items.length,0),
   inferredLines:result.receipts.flatMap(r=>r.items).filter(i=>i.evidence?.method==='complementary_modifiers').length,
   ambiguousLines:result.receipts.flatMap(r=>r.items).filter(i=>i.evidence?.method==='preserved_ambiguous').length,
   canonicalOrders:result.receipts.map(r=>({date:r.orderDate,restaurant:r.restaurantName,exportedAmount:r.amountSpent,items:r.items,resolution:r.resolution,
     subtotal:moneySum(r.items.map(i=>i.evidence?.configuredLineTotal??i.price*i.quantity))})),
   candidates};
  process.stdout.write(JSON.stringify(output,null,2)+'\n');
 } finally { if(extracted) await extracted.remove(); }
})().catch(error=>{process.stderr.write(error.message+'\n');process.exitCode=1;});
