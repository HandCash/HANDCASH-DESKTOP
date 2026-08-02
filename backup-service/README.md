# HandCash Backup Service

Optional **backup service** (share vault): stores **one** BRC-140 recovery slice per user and releases it only after OTP auth.

Anyone can run an instance. Wallets add the URL under **Settings → Backup services** (Desktop ships with an **empty** default list).

## Quick start

```bash
cd backup-service
npm install
npm start
# → http://127.0.0.1:8787
```

Dev OTP is printed in the server log and returned in the `start-auth` JSON (`devCode`) so local testing does not need email.

```bash
npm test           # single-instance API smoke test
npm run test:cluster  # 2-of-3 across three local ports
```

## Multi-provider local cluster

```bash
PORT=8787 DATA_DIR=./data/a NAME="Local A" npm start &
PORT=8788 DATA_DIR=./data/b NAME="Local B" npm start &
PORT=8789 DATA_DIR=./data/c NAME="Local C" npm start &
```

Enroll the same `userIdHash` on each with a different share. Restore with any two.

## Lifecycle / shutdown

`GET /info` includes `lifecycle` (`active` | `sunset` | `retired`) so wallets can warn users to rotate before `retireAt`.

```bash
# mark sunset (operator tool)
node src/set-lifecycle.js sunset --retire-at 2027-06-01T00:00:00Z
```

## API

| Method | Path | Notes |
|--------|------|--------|
| GET | `/info` | Name, auth methods, lifecycle |
| POST | `/auth/start` | `{ email }` → `{ requestId, devCode? }` |
| POST | `/auth/verify` | `{ requestId, code }` → `{ token }` |
| POST | `/share/enroll` | Bearer token + `{ userIdHash, share }` |
| POST | `/share/retrieve` | Bearer token + `{ userIdHash }` → `{ share }` |
| POST | `/share/delete` | Bearer token + `{ userIdHash }` |

**Invariant:** at most one share per `userIdHash`. Never send the root key.

## Env

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | `8787` | Listen port |
| `HOST` | `127.0.0.1` | Bind address |
| `DATA_DIR` | `./data` | JSON store directory |
| `NAME` | `Local Backup Service` | `/info` display name |
| `DEV_OTP` | `000000` | Fixed OTP in development |
