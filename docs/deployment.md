# Deploying Pixhaus

> One box, `docker compose`, automatic TLS. Written for someone who has not
> deployed anything before, so every step says what it does and why it is there.
>
> The reference deployment is an **Oracle Cloud Always Free ARM instance** with
> **Cloudflare R2** for storage and **Resend** for email — all three free. Any
> Linux box with Docker, any S3-compatible bucket and any SMTP provider work the
> same way.

## What you are building

```
                      ┌─────────────── your box ────────────────┐
  browser ── 443 ──▶  │  caddy ──▶ api ──┬──▶ postgres          │
                      │              │   └──▶ redis ──▶ worker  │
                      └──────────────┼──────────────────────────┘
                                     │
  browser ◀── photos, direct ───── Cloudflare R2 ◀── worker
```

Caddy is the only thing listening on a public port. Postgres and Redis are bound
to `127.0.0.1`, so they are unreachable from the internet even though the box has
a public IP. **Photos never pass through the API** — the browser PUTs and GETs
them straight from R2 using presigned URLs, which is what makes this cheap enough
to run on a free instance.

---

## 0. Before you touch a server

Three accounts and a domain. Roughly an hour, mostly waiting for DNS.

### 0a. A domain

Buy one anywhere (Cloudflare and Namecheap are both about €10/year). You need it
before anything else works: **the session cookie is `Secure` in production**, so
without HTTPS a browser accepts your login and then silently discards the cookie.
The symptom is a login that appears to succeed and a next request that is
`401` — with nothing in the logs, because nothing went wrong on the server.

### 0b. Cloudflare R2

R2 is S3-compatible object storage with **no egress fees**, which matters when a
client downloads a 4 GB gallery. Free below 10 GB stored.

1. Sign up at Cloudflare, then **R2 → Create bucket**. Name it `pixhaus`. Leave
   it private — every URL the app hands out is presigned and expires.
2. **R2 → Manage R2 API Tokens → Create API token**. Permission **Object Read &
   Write**, scoped to that one bucket. Copy the **Access Key ID** and **Secret
   Access Key** — the secret is shown once.
3. Note your **S3 API endpoint**, which looks like
   `https://<account-id>.r2.cloudflarestorage.com`.
4. **Bucket → Settings → CORS Policy.** Without this every browser upload fails
   at the PUT, because the browser refuses to send a cross-origin request the
   bucket has not opted into:

   ```json
   [
     {
       "AllowedOrigins": ["https://pixhaus.example.com"],
       "AllowedMethods": ["PUT", "GET"],
       "AllowedHeaders": ["content-type", "content-length"],
       "ExposeHeaders": ["etag"],
       "MaxAgeSeconds": 3600
     }
   ]
   ```

   `content-type` and `content-length` are in `AllowedHeaders` because both are
   inside the upload signature — the browser must send exactly what was signed.
   `etag` is exposed because the browser reads it back after a successful PUT.

### 0c. Resend

Verification links and client magic links both go out by SMTP. Free tier is
3,000 emails a month.

1. Sign up, then **Domains → Add Domain** and add the DNS records it gives you
   to your registrar. These are SPF and DKIM records: they are how a receiving
   mail server knows Resend is allowed to send as your domain. Without them your
   mail lands in spam, which for a magic link means the client never gets in.
2. **API Keys → Create.** The SMTP credentials are username `resend` and the API
   key as the password:
   `smtp://resend:<api-key>@smtp.resend.com:587`

---

## 1. The instance

**Compute → Instances → Create instance.** The defaults are wrong in two places:

| Field   | Set it to                                                |
| ------- | -------------------------------------------------------- |
| Image   | Canonical **Ubuntu 24.04**                               |
| Shape   | Ampere → `VM.Standard.A1.Flex` → **2 OCPUs, 12 GB**      |
| Network | Create new VCN + **public subnet**, assign a public IPv4 |
| SSH key | Paste your `~/.ssh/id_ed25519.pub`                       |

"Out of host capacity" is the well-known ARM shortage, not a mistake — try
another Availability Domain or come back later.

### Reserve the IP

Oracle gives you an **ephemeral** public IP by default, which changes if the
instance is ever stopped and started. Your DNS record and your TLS certificate
both point at that address, so a change breaks the site until you notice.

**Instance → Attached VNICs → the VNIC → IPv4 Addresses → edit the primary →
Public IP: Reserved**, and create a new reserved address. Free, and it is yours
until you release it.

---

## 2. DNS

At your registrar, one record:

| Type | Name             | Value            |
| ---- | ---------------- | ---------------- |
| `A`  | `@` or `pixhaus` | your reserved IP |

Then **wait for it to resolve before starting Caddy**:

```bash
dig +short pixhaus.example.com
```

This matters: Caddy asks Let's Encrypt for a certificate on first request, and
Let's Encrypt proves you own the domain by connecting to it. If the name does not
resolve yet the attempt fails, and **repeated failures get you rate-limited for
an hour**. Wait for `dig` to return your IP before step 5.

---

## 3. Both firewalls

Oracle instances sit behind **two** independent firewalls, and forgetting the
second is the single most common way to lose an afternoon here. The symptom is
specific: connections to port 443 **hang with no response and nothing in any
log**, because the packets are dropped before they reach anything that logs.

### 3a. The cloud firewall

**Networking → Virtual Cloud Networks → your VCN → Security Lists → Default
Security List → Add Ingress Rules.** Two rules:

| Source      | Protocol | Destination port |
| ----------- | -------- | ---------------- |
| `0.0.0.0/0` | TCP      | 80               |
| `0.0.0.0/0` | TCP      | 443              |

Port 80 as well as 443, because Let's Encrypt's HTTP challenge uses it and Caddy
redirects plain HTTP to HTTPS.

### 3b. The firewall on the machine

Ubuntu images from Oracle ship with `iptables` rules that reject everything
except SSH.

**Position is the whole game.** iptables walks the chain top to bottom and stops
at the first match, and the chain ends with a catch-all REJECT. A rule added
after it is never reached — the ports look open in the config and are closed in
reality. So find the REJECT and insert above it rather than guessing a number:

```bash
REJECT=$(sudo iptables -L INPUT --line-numbers -n | awk '$2 == "REJECT" { print $1; exit }')
sudo iptables -I INPUT "$REJECT" -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT "$REJECT" -m state --state NEW -p tcp --dport 443 -j ACCEPT
```

Check it landed correctly — both ACCEPTs must be _above_ the REJECT:

```bash
sudo iptables -L INPUT --line-numbers
```

If they ended up below it, delete them **highest number first** (deleting a rule
renumbers everything under it) and try again:

```bash
sudo iptables -D INPUT 7
sudo iptables -D INPUT 6
```

Then persist, or they vanish on the next reboot and the site goes down with no
change having been made:

```bash
sudo netfilter-persistent save
```

---

## 4. Docker

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker ubuntu
exit
```

Then SSH back in — group membership only applies to a new login. `docker compose
version` should answer.

---

## 5. Deploy

```bash
git clone https://github.com/RaresPetrisor22/pixhaus.git
cd pixhaus
cp .env.production.example .env
nano .env
```

The file has three kinds of blank, labelled in place:

| Kind          | Which                                                                                                       | Comes from                    |
| ------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **GENERATE**  | `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `REDIS_PASSWORD`, `CLIENT_TOKEN_SECRET`, `REGISTRATION_INVITE_CODE` | random strings you invent now |
| **DASHBOARD** | `STORAGE_ENDPOINT`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `SMTP_URL`                                  | Cloudflare and Resend         |
| **MATCH DNS** | `DOMAIN`, `APP_URL`, `SMTP_FROM`                                                                            | your domain                   |

### The generated ones, in one go

```bash
PG=$(openssl rand -hex 24)
APP=$(openssl rand -hex 24)
REDIS=$(openssl rand -hex 24)
TOKEN=$(openssl rand -hex 32)
INVITE=$(openssl rand -hex 8)

sed -i \
  -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$PG|" \
  -e "s|^APP_DB_PASSWORD=.*|APP_DB_PASSWORD=$APP|" \
  -e "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=$REDIS|" \
  -e "s|^CLIENT_TOKEN_SECRET=.*|CLIENT_TOKEN_SECRET=$TOKEN|" \
  -e "s|^REGISTRATION_INVITE_CODE=.*|REGISTRATION_INVITE_CODE=$INVITE|" \
  -e "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://pixhaus_app:$APP@localhost:5432/pixhaus|" \
  -e "s|^MIGRATION_DATABASE_URL=.*|MIGRATION_DATABASE_URL=postgresql://pixhaus_owner:$PG@localhost:5432/pixhaus|" \
  .env

echo "invite code: $INVITE"
```

**Hex rather than base64, deliberately.** Two of those passwords are embedded in
`DATABASE_URL`, which is a URL: a `/`, `+` or `@` inside the password breaks the
parser, and the result is an authentication failure that looks nothing like a
quoting problem. Hex contains none of them.

The same command rewrites both connection strings so they agree with the
passwords — the template ships them holding `CHANGEME`, and forgetting to update
them is easy to do and unpleasant to diagnose.

Keep the invite code: it is the only way to create an account once this is live.

### The rest, by hand

`nano .env`, and fill in the domain, the R2 endpoint and keys, and the Resend
SMTP URL. Then check nothing was missed:

```bash
grep -nE '^[A-Z_]+=$|CHANGEME|example\.com|<' .env
```

That prints every line still empty or still holding a placeholder. It should
print nothing.

**`POSTGRES_PASSWORD` and `APP_DB_PASSWORD` are the two to get right first
time.** `docker/postgres/init/01-create-app-role.sh` bakes them into the database
roles, and it only runs against an **empty data volume**. Changing them later
means `docker compose down -v` — which deletes the database — or an `ALTER ROLE`
by hand.

Then:

```bash
docker compose up -d --build --wait
```

What that does, in order:

| Service    | Does                                                                           |
| ---------- | ------------------------------------------------------------------------------ |
| `postgres` | Starts, and on a fresh volume runs the init script that creates the app role   |
| `redis`    | The job queue                                                                  |
| `migrate`  | Applies migrations **as the owner role**, then exits 0. The API waits for this |
| `api`      | Starts once migrate succeeded and Postgres is healthy                          |
| `worker`   | Consumes the rendition queue                                                   |
| `caddy`    | Gets a certificate on first request and proxies to `api:3000`                  |

`--wait` blocks until every health check passes, so when it returns the stack is
genuinely serving rather than merely started. The first build takes several
minutes; it compiles TypeScript and installs native binaries.

`migrate` runs as the **owner** role and everything else as the **app** role.
That asymmetry is the whole tenant-isolation design: the owner creates the
tables, so the app role is subject to their row-level security policies. See
[ADR 0003](adr/0003-photographer-sessions-and-the-rls-bootstrap.md).

---

## 6. Verify

```bash
docker compose ps                 # everything healthy, no minio, no mailpit
docker compose logs migrate       # applied once, exited 0
docker compose logs caddy         # "certificate obtained successfully"
curl -sf https://pixhaus.example.com/readyz
```

Then create an account. Registration is invite-gated in production, so pass the
code from your `.env`:

```bash
curl -sX POST https://pixhaus.example.com/api/auth/register \
  -H 'content-type: application/json' \
  -d '{"studioName":"Your Studio","email":"you@example.com",
       "password":"a long passphrase","inviteCode":"<REGISTRATION_INVITE_CODE>"}'
```

A real email should arrive. Click the link — that proves Resend, your DNS
records and `APP_URL` are all correct at once. Then run the full flow:

```bash
SMOKE_EMAIL=you@example.com SMOKE_PASSWORD='a long passphrase' \
  scripts/smoke.sh https://pixhaus.example.com ~/photo.jpg
```

It logs in, uploads a photo, waits for renditions, shares it, opens the magic
link as a client, fetches a thumbnail **straight from R2 with no credential**,
downloads the original and compares the bytes, then revokes and confirms both
tiers are dead.

### The five things that are only true in production

Check these individually if the smoke test fails:

| Symptom                                         | Cause                                                        |
| ----------------------------------------------- | ------------------------------------------------------------ |
| Login succeeds, next request is `401`           | Not actually on HTTPS. The `Secure` cookie is being dropped  |
| The PUT is rejected with a CORS error           | The R2 CORS rule (0b) is missing or names the wrong origin   |
| Presigned URLs point at `localhost`             | `STORAGE_PUBLIC_ENDPOINT` still has a development value      |
| The magic link 404s from an email               | `APP_URL` does not match the domain                          |
| Rate limits trip far too easily for one visitor | `trust proxy` — every request looks like it comes from Caddy |

And from **a machine that is not the box**, confirm nothing else is exposed:

```bash
curl -sf https://pixhaus.example.com/healthz     # 200
nc -zv pixhaus.example.com 5432                  # refused
nc -zv pixhaus.example.com 6379                  # refused
```

Running that from the server itself proves nothing — `127.0.0.1` bindings answer
locally by design.

---

## 7. Operating it

### Updating

```bash
cd ~/pixhaus && git pull && docker compose up -d --build --wait
```

`api`, `worker` and `migrate` all bake source into their images, so **a `git
pull` alone changes nothing** — `--build` is what matters. A new migration is
invisible to the `migrate` container until its image is rebuilt.

### Logs

```bash
docker compose logs -f api
docker compose logs -f worker
docker compose logs --since 1h caddy
```

### Backups

The database is the only thing that is not reproducible — photos are in R2, and
the code is in git. A nightly dump:

```bash
sudo tee /etc/cron.daily/pixhaus-backup >/dev/null <<'EOF'
#!/bin/sh
cd /home/ubuntu/pixhaus
docker compose exec -T postgres pg_dump -U pixhaus_owner pixhaus \
  | gzip > /home/ubuntu/backups/pixhaus-$(date +%F).sql.gz
find /home/ubuntu/backups -name 'pixhaus-*.sql.gz' -mtime +14 -delete
EOF
sudo chmod +x /etc/cron.daily/pixhaus-backup
mkdir -p ~/backups
```

A backup you have never restored is a hope, not a backup. Test it once:
`gunzip -c backup.sql.gz | docker compose exec -T postgres psql -U pixhaus_owner pixhaus`
against a throwaway database.

### When the disk fills

Docker images accumulate on every rebuild:

```bash
df -h /
docker system prune -af --volumes    # careful: --volumes deletes unused volumes
```

Photos do not consume local disk — they are in R2 — so growth here is images and
logs, not user data.

### Rotating secrets

- `CLIENT_TOKEN_SECRET` — invalidates every outstanding client token immediately.
  Clients recover by re-opening their magic link. This is the emergency brake
  that per-grant revocation is not.
- `REGISTRATION_INVITE_CODE` — change it and restart the API to stop a leaked
  code being used.
- Database passwords — see the warning in step 5. Not a five-minute job.

Both take effect on `docker compose up -d api`.
