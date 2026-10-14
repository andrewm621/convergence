/** Deterministic stand-in actors for repeatable tests. NOT independent model inference or an OS sandbox. */
import { parentPort, workerData } from 'node:worker_threads';
const p = workerData.packet;
const outputs = {
  builder: {'evidence.counts-as-test':'claims-check'},
  console: {'evidence.claims-check-role':'test'},
  docs: {'identity.label':'Decision owner (demo identity)'},
  'red-team': {finding:'An agent-written claims check is not independent executed-test evidence.'}
};
if (!outputs[p.id]) throw new Error(`Unknown stand-in role ${p.id}`);
// Each worker can inspect only the packet it was given via workerData in this demonstration.
parentPort.postMessage({id:p.id, workItemId:p.workItemId, asserted:outputs[p.id],
  basedOn:`${p.receipt.recordId}@${p.receipt.version}`, claimOfTestPass:p.id==='builder',
  finding:p.id==='red-team'?'Self-attestation cannot establish an executed check.':undefined });