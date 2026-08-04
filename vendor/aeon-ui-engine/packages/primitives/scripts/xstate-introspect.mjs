import { asyncMachine } from '../dist/index.js';
import { createActor, getStateNodes, getNextTransitions, __unsafe_getAllOwnEventDescriptors } from 'xstate';
import { getStateNodes as graphGetStateNodes } from 'xstate/graph';

const machine = asyncMachine;
console.log('=== Object.keys(machine) ===');
console.log(Object.keys(machine));
console.log('\n=== Object.keys(machine.states) ===');
console.log(Object.keys(machine.states));
const idle = machine.states.idle;
console.log('\n=== idle: Object.keys(idle) ===');
console.log(Object.keys(idle));
console.log('\n=== idle.events ===');
console.log(idle.events);
console.log('\n=== idle.config.on ===');
console.log(JSON.stringify(idle.config.on, null, 2));
const actor = createActor(machine);
actor.start();
const snap = actor.getSnapshot();
console.log('\n=== snapshot.value ===');
console.log(snap.value);
console.log("\n=== snapshot.can({ type: 'FETCH' }) ===");
console.log(snap.can({ type: 'FETCH' }));
console.log('\n=== typeof snap.getNextEvents ===');
console.log(typeof snap.getNextEvents);
console.log('\n=== getNextTransitions(snap) ===');
console.log(getNextTransitions(snap).map((t) => ({ eventType: t.eventType, target: t.target })));
console.log('\n=== __unsafe_getAllOwnEventDescriptors(snap) ===');
console.log(__unsafe_getAllOwnEventDescriptors(snap));
console.log('\n=== snap._nodes events ===');
for (const n of snap._nodes) console.log(n.id, n.events);
console.log('\n=== graphGetStateNodes ===');
for (const n of graphGetStateNodes(machine)) {
  console.log({ id: n.id, events: n.events, onKeys: n.config?.on ? Object.keys(n.config.on) : [] });
}
