import test from 'node:test';
import assert from 'node:assert/strict';
import { readFixture,makePackets,validatePacket,evaluate,simulate } from './proof.mjs';

const f = await readFixture();
const packets = makePackets(f);
const results = await simulate(f,packets);
const report = evaluate(f, packets, results);
const result = id => report.results.find(r=>r.actor===id);

test('concurrent stand-in agents have role-scoped, individually hashed receipts',()=>{
  assert.equal(packets.length,4);
  for(const packet of packets) assert.equal(validatePacket(packet, f.roles.find(r=>r.id===packet.id)),true);
  assert.notDeepEqual(packets.find(p=>p.id==='builder').context,packets.find(p=>p.id==='red-team').context);
  assert.equal(JSON.stringify(packets.find(p=>p.id==='red-team')).includes('priorPractice'),false);
  assert.equal(JSON.stringify(packets.find(p=>p.id==='builder')).includes('trustedTestReceipt'),false);
  for(const p of packets) assert.equal(Object.hasOwn(p,'asserted'),false);
});
test('real decision change flags exactly the stale historical dependencies',()=>{
  assert.deepEqual(report.changedFacets.sort(),['evidence.claims-check-role','evidence.counts-as-test']);
  assert.equal(result('builder').status,'revalidation-required');
  assert.equal(result('console').status,'revalidation-required');
  assert.equal(result('docs').status,'unaffected');
  assert.equal(result('red-team').status,'finding-proposed');
  assert.deepEqual(result('builder').affectedFacets,['evidence.counts-as-test','evidence.claims-check-role']);
  assert.deepEqual(result('console').affectedFacets,['evidence.counts-as-test','evidence.claims-check-role']);
});
test('a delivered receipt is not proof of correct understanding',()=>{
  assert.equal(result('builder').claimsConflict,true);
  assert.equal(result('console').claimsConflict,true);
  assert.equal(result('builder').trustedExecutedTest,false);
  assert.equal(report.acceptedChanges.length,0);
});
test('agent-asserted permissions and passing tests cannot authorize promotion',()=>{
  const forged=results.map(x=>x.id==='builder'?{...x,approve:true,forcePromote:true,claimsTrusted:true}:x);
  const r=evaluate(f,packets,forged);
  assert.equal(r.attemptedEscalations.length,1);
  assert.equal(r.acceptedChanges.length,0);
  assert.equal(r.results.find(x=>x.actor==='builder').status,'revalidation-required');
});
test('bad or missing receipts fail closed',()=>{
  const tampered=packets.map(p=>p.id==='builder'?{...p,receipt:{...p.receipt,version:2}}:p);
  const r=evaluate(f,tampered,results);
  assert.equal(r.results.find(x=>x.actor==='builder').status,'unknown-blocked');
  const noOutput=evaluate(f,packets,results.filter(x=>x.id!=='console'));
  assert.equal(noOutput.results.find(x=>x.actor==='console').status,'unknown-blocked');
});
test('authority, rationale and binding required for an illustrative exception',()=>{
  const r1=evaluate(f,packets,results,{resolution:{actor:'red-team',kind:'accept-exception',binding:f.change.to.commit,rationale:'ignored'}});
  assert.equal(r1.acceptedChanges.length,0);
  const r2=evaluate(f,packets,results,{resolution:{actor:'decision-owner',kind:'accept-exception',binding:f.change.to.commit,rationale:'Scoped review approved',scope:'WI-1'}});
  assert.equal(r2.acceptedChanges.length,1);
  assert.equal(r2.acceptedChanges[0].scope,'WI-1');
});
test('prose or unrelated facet updates do not cause speculative invalidations',()=>{
  const other=structuredClone(f);
  other.change.to.facets={...other.change.from.facets};
  const r=evaluate(other,makePackets(other),results);
  assert.equal(r.results.find(x=>x.actor==='builder').status,'unaffected');
  assert.equal(r.results.find(x=>x.actor==='console').status,'unaffected');
  assert.equal(r.results.find(x=>x.actor==='docs').status,'unaffected');
});
test('an exception must name one affected work item; blanket exceptions fail',()=>{
  const r=evaluate(f,packets,results,{resolution:{actor:'decision-owner',kind:'accept-exception',binding:f.change.to.commit,rationale:'Invalid blanket exception'}});
  assert.equal(r.acceptedChanges.length,0);
});