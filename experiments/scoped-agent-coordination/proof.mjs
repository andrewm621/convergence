/**
 * Scoped-context proof for the actual Convergence repository's historical evidence-policy change.
 * Standalone experiment: NOT a replacement for packages/delta-core or the production merge gate.
 * No model is called. The simulate command runs separate deterministic Worker threads with unequal packets.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

const here = dirname(fileURLToPath(import.meta.url));
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

export function makePackets(fixture) {
  return fixture.roles.map(role => {
    const governing = role.receipt.recordId === fixture.change.recordId
      ? (role.receipt.version === fixture.change.from.version ? fixture.change.from : fixture.change.to)
      : { version: role.receipt.version, facets: { 'identity.label': 'Decision owner (demo identity)' } };
    const allowedFacets = Object.fromEntries(Object.entries(governing.facets).filter(([key]) => role.dependsOn.includes(key)));
    const delivered = { recordId: role.receipt.recordId, version: role.receipt.version, facets: allowedFacets };
    return {
      id: role.id,
      workItemId: role.workItemId,
      task: role.task,
      capabilities: [...role.capabilities],
      context: structuredClone(role.visibleKnowledge),
      receipt: { ...delivered, hash: sha(delivered) },
      dependencies: [...role.dependsOn],
      artifactRef: role.artifactRef ?? null,
      baselineRef: role.baselineRef,
      // Actor outputs are only seeded for the deterministic demonstration.
      // They do not enter the packet a real model is given.
    };
  });
}

export function validatePacket(packet, role) {
  if (packet.id !== role.id || packet.workItemId !== role.workItemId) return false;
  const { hash, ...delivered } = packet.receipt;
  return sha(delivered) === hash &&
    packet.dependencies.every(k => own(packet.receipt.facets, k)) &&
    !own(packet, 'asserted') && !own(packet, 'secret') && !own(packet, 'globalContext') &&
    JSON.stringify(packet).length < 20000;
}

export function evaluate(fixture, packets, submissions, { resolution = null } = {}) {
  const map = new Map(packets.map(p => [p.id, p]));
  const changed = Object.keys(fixture.change.to.facets).filter(k =>
    JSON.stringify(fixture.change.from.facets[k]) !== JSON.stringify(fixture.change.to.facets[k]));
  const report = { project: fixture.project, scenario: 'scoped-knowledge-independent-work',
    historicalReconstruction: true, independentModelRuns: false,
    authoritativeChange: `${fixture.change.recordId}@${fixture.change.from.version} -> @${fixture.change.to.version}`,
    changedFacets: changed, results: [], acceptedChanges: [], attemptedEscalations: [] };
  for (const role of fixture.roles) {
    const packet = map.get(role.id);
    const submission = submissions.find(s => s.id === role.id);
    if (!packet || !validatePacket(packet, role) || !submission || submission.workItemId !== role.workItemId) {
      report.results.push({ actor: role.id, workItemId: role.workItemId, status: 'unknown-blocked', reason: 'INVALID_OR_MISSING_RECEIPT' });
      continue;
    }
    // Submissions may contain claims, but never confer approval or trusted test evidence.
    if (submission.approve || submission.forcePromote || submission.claimsTrusted) {
      report.attemptedEscalations.push({ actor: role.id, reason: 'AGENT_CANNOT_AUTHORIZE_OR_ATTEST_TRUSTED_EVIDENCE' });
    }
    const affectedFacets = packet.receipt.recordId === fixture.change.recordId &&
      packet.receipt.version < fixture.change.to.version
      ? packet.dependencies.filter(k => changed.includes(k)) : [];
    const claimsConflict = Object.entries(submission.asserted ?? {}).some(([key,value]) =>
      own(fixture.change.to.facets, key) && JSON.stringify(fixture.change.to.facets[key]) !== JSON.stringify(value));
    const isReviewer = role.id === 'red-team';
    const status = affectedFacets.length ? 'revalidation-required' : isReviewer ? 'finding-proposed' : 'unaffected';
    report.results.push({ actor: role.id, workItemId: role.workItemId, status,
      affectedFacets, claimsConflict, authority: 'proposal-only',
      trustedExecutedTest: false,
      reason: affectedFacets.length ? 'RECORDED_DEPENDENCY_ON_CHANGED_FACET' : isReviewer ? 'INDEPENDENT_CHALLENGE_REQUIRES_REVIEW' : 'NO_CHANGED_FACET_DEPENDENCY' });
  }
  if (resolution) {
    if (resolution.actor !== fixture.change.authority || resolution.kind !== 'accept-exception' ||
        !resolution.rationale?.trim() || !resolution.binding ||
        resolution.binding !== fixture.change.to.commit ||
        !report.results.some(r => r.workItemId === resolution.scope && r.status === 'revalidation-required')) {
      report.attemptedEscalations.push({actor: resolution.actor,reason:'INVALID_AUTHORITY_OR_UNBOUND_EXCEPTION'});
    } else {
      report.acceptedChanges.push({ actor: resolution.actor, kind: resolution.kind, scope: resolution.scope, rationale: resolution.rationale,
        boundTo: resolution.binding, note: 'Illustrative exception receipt only; the actual Convergence promotion gate is not invoked.' });
    }
  }
  return report;
}

export async function simulate(fixture, packets) {
  const workerUrl = new URL('./role-worker.mjs', import.meta.url);
  // Each worker gets ONLY its own scoped packet. The fixture and all other packets stay in the parent.
  return Promise.all(packets.map(packet => new Promise((done, fail) => {
    const worker = new Worker(workerUrl, { workerData: { packet } });
    worker.once('message', done); worker.once('error', fail);
    worker.once('exit', code => { if (code !== 0) fail(new Error(`Worker ${packet.id} exited ${code}`)); });
  })));
}

export async function prepare(fixture, dest) {
  const packets = makePackets(fixture);
  await mkdir(join(dest, 'packets'), {recursive:true});
  await mkdir(join(dest, 'submissions'), {recursive:true});
  for (const packet of packets) {
    await writeFile(join(dest,'packets',`${packet.id}.json`), JSON.stringify(packet,null,2)+'\n');
  }
  await writeFile(join(dest,'README.md'), `# Scoped work handoff\n\nEach agent receives only packets/<role>.json and a separate runtime/worktree.\nWrite one output as submissions/<role>.json with id, workItemId, asserted and optional finding.\nDo not treat an agent's claimed tests or approvals as trusted evidence.\nRun: node proof.mjs review --dir ${dest}\n\nThe fixture is a retrospective reconstruction from andrewm621/convergence; packet handoff alone is NOT a security sandbox.\n`);
  return packets;
}

export async function readFixture() {
  return JSON.parse(await readFile(join(here, 'fixture.json'), 'utf8'));
}

async function cli() {
  const command = process.argv[2] ?? 'simulate';
  const arg = process.argv.indexOf('--dir');
  const dir = arg >= 0 ? resolve(process.argv[arg+1] ?? '.') : resolve(here, 'run-output');
  const fixture = await readFixture();
  const packets = await prepare(fixture, dir);
  if (command === 'prepare') {
    console.log(`Created ${packets.length} separate packets in ${dir}/packets`);
    return;
  }
  if (command === 'simulate') {
    const submissions = await simulate(fixture, packets);
    for (const submission of submissions) await writeFile(join(dir,'submissions',`${submission.id}.json`),JSON.stringify(submission,null,2)+'\n');
  } else if (command !== 'review') {
    throw new Error('Usage: node proof.mjs prepare|simulate|review [--dir path]');
  }
  const submissions = [];
  for (const packet of packets) {
    try { submissions.push(JSON.parse(await readFile(join(dir,'submissions',`${packet.id}.json`),'utf8'))); }
    catch { /* missing or malformed is represented as unknown-blocked */ }
  }
  const report = evaluate(fixture, packets, submissions);
  await writeFile(join(dir,'report.json'), JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(err => {console.error(err); process.exitCode=1;});
}