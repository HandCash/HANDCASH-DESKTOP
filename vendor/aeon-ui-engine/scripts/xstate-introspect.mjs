import { asyncMachine } from '../packages/primitives/dist/index.js';
import { createActor, getStateNodes } from 'xstate';
import { getStateNodes as graphGetStateNodes } from 'xstate/graph';

const machine = asyncMachine;

console.log('=== machine keys ===');
console.log(Object.keys(machine).sort().join(', '));

console.log('\n=== machine.states keys ===');
console.log(Object.keys(machine.states));

const idle = machine.states.idle;
console.log('\n=== idle state node keys ===');
console.log(Object.keys(idle).sort().join(', '));

console.log('\n=== idle.events ===');
console.log(idle.events);

console.log('\n=== idle.config.on ===');
console.log(idle.config?.on ?? idle.config);

const actor = createActor(machine);
actor.start();
const snap = actor.getSnapshot();

console.log('\n=== snapshot.value ===');
console.log(snap.value);

console.log("\n=== snapshot.can({ type: 'FETCH' }) ===");
console.log(snap.can({ type: 'FETCH' }));

console.log('\n=== snapshot keys (sorted) ===');
console.log(Object.keys(snap).sort().join(', '));

if (typeof snap.getNextEvents === 'function') {
  console.log('\n=== snap.getNextEvents() ===');
  console.log(snap.getNextEvents());
}

// _nodes internal?
if (snap._nodes) {
  console.log('\n=== snap._nodes ids ===');
  console.log([...snap._nodes].map((n) => n.id));
}

const nodes = getStateNodes(machine.root, snap.value);
console.log('\n=== getStateNodes(root, value) ===');
console.log(nodes.map((n) => n.id));
console.log('active node .events:', nodes.map((n) => ({ id: n.id, events: n.events })));

const allNodes = graphGetStateNodes(machine);
console.log('\n=== graph.getStateNodes(machine) ===');
for (const n of allNodes) {
  console.log({ id: n.id, events: n.events, on: n.config?.on ? Object.keys(n.config.on) : [] });
}

const eventTypes = ['FETCH', 'RESOLVE', 'REJECT', 'RESET', 'STALE', 'REFRESH'];
console.log('\n=== idle snapshot: can() per event ===');
for (const type of eventTypes) {
  const ev =
    type === 'RESOLVE'
      ? { type, data: { x: 1 } }
      : type === 'REJECT'
        ? { type, error: 'e' }
        : { type };
  console.log(type, snap.can(ev));
}
