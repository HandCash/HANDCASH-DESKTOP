import { spawnSync } from 'node:child_process'

// One vitest process keeps every file it has run. On the release runners that
// process reaches Node's heap limit after most of the suite has passed, and
// the installer is never uploaded. A fresh process per shard drops that heap.
const shards = 8

for (let shard = 1; shard <= shards; shard += 1) {
  console.info(`[test:ci] shard ${shard}/${shards}`)
  const result = spawnSync(
    'npx',
    ['vitest', 'run', '--reporter=default', '--maxWorkers=1', `--shard=${shard}/${shards}`],
    { stdio: 'inherit', env: process.env, shell: process.platform === 'win32' }
  )
  if (result.status !== 0) process.exit(result.status ?? 1)
}
