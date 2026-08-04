/** Map component schema `machine` export names → registry/machines/{id}.json ids. */
export function machineRegistryId(machine: string | null | undefined): string | undefined {
  if (machine == null) return undefined
  if (machine === 'createAsyncMachine') return 'async'
  if (machine.endsWith('Machine')) return machine.slice(0, -'Machine'.length)
  return machine
}
