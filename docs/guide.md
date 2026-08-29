Steps:

1. **Get the code and dependencies**: clone it, `bun install` (or `npm install`) once so `node_modules` resolves — then `bun run <path>/src/cli/main.ts ...` works directly against source, no build step needed (that's exactly what we've been doing all session).
2. **Have a working embedding provider reachable**: LM Studio running locally with at least one downloaded embedding-only model, since that's v10's default/only well-supported path right now.
3. **Have a Postgres+pgvector target reachable**: either Docker/Podman available (for the managed-local default), or a real existing Postgres with `pgvector` enabled/allow-listed and a working, correctly-encoded connection string.
4. **Actually run `frag add` at least once** to provision a system. This is the step your "and that's it" skips — the MCP server doesn't create anything, it only serves whatever's already in the global registry. Before this, `list_collections` returns empty and every `ingest`/`search` call fails with `Unknown collection`.
5. **Point your MCP client at `bun <path>/src/cli/main.ts mcp`**, and for any collection using `existing-postgres`, declare its required env var (e.g. `DATABASE_URL`) in *that specific MCP server config's* `env` block — not just somewhere in your shell. This was the whole saga we just went through.
6. **Reconnect the MCP client** so it picks up current registry state.

So it's really: (code + dependencies) → (working embedder + working database) → **provision at least one system** → (MCP config with correct env) → reconnect. Steps 2–4 are the part "clone it and add to MCP" glosses over, and they're exactly where all our real friction today came from.




```json
{
    "mcpServers": {
    "frag": {
        "type": "stdio",
        "command": "/home/ffacu/.bun/bin/bun",
        "args": [
        "/home/ffacu/q/apps/systems/frag/src/cli/main.ts",
        "mcp"
        ],
        "env": {}
    },
}
```

```
export DATABASE_URL="postgres://user:password@your-server.postgres.database.azure.com:5432/dbname?sslmode=require"
```


Note that when using a cloud database, the DATABASE_URL needs to be set 

For each database

1. Two clouds — do you need two env vars? Depends on whether they're the same physical database or not:
- Same Postgres server, multiple collections in it → reuse the same env var (e.g.  DATABASE_URL for both), exactly like your local systems (fleet-smoketest, s, test1) all already share one managed:local database. Frag separates collections by column + per-dimension tables within one database, so this is fine and is the "one shared cloud DB" pattern.
- Two genuinely different servers/instances → you need two distinct env var names (e.g. DATABASE_URL, DATABASE_URL_2, or better, named ones like AZURE_MAIN_DB_URL / AZURE_ANALYTICS_DB_URL). This isn't just a convenience — it's structural: frag derives the database's registry identity directly from the env var name same env var name, frag would treat them as one logical database record, and whichever URL happens to be in that variable at connection time is what both systems would silently use. So: one env var per distinct physical database, always.





## Azure configuration

**Note**: For Azure, you have to enable the vector extension manually. To do in the Azure portal: your server → Settings → Server parameters → search azure.extensions → add VECTOR to the allowed list → Save.



### Testing postgres connection


```sh
export PGHOST=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
export PGUSER=xxxxxxx
export PGPORT=5432
export PGDATABASE=xxxxxxxx
export PGPASSWORD=xxxxxxxxxxxxxxxxxxx


export DATABASE_URL="postgres://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/${PGDATABASE}?sslmode=require"

bun -e "
import { Client } from 'pg';
const client = new Client({
  host: process.env.PGHOST,
  user: 'pgadmin',
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  ssl: { rejectUnauthorized: false },
});
try {
  await client.connect();
  console.log('CONNECTED');
} catch (e) {
  console.error('FAILED:', e.message);
} finally {
  await client.end();
}
"
```

An unescaped `@` in the password breaks the URL parser since it looks like the credentials/host separator, so the actual hostname ends up empty. Fix it by percent-encoding just the password. Do this in your shell so the raw password never has to go through chat:

```bash
read -s -p "Postgres password: " PGPASSWORD; echo
ENCPASS=$(node -e "console.log(encodeURIComponent(process.argv[1]))" "$PGPASSWORD")
export DATABASE_URL="postgres://$PGUSER:${ENCPASS}@$PGHOST/<dbname>?sslmode=require"
unset PGPASSWORD
```

To verify it parses correctly before retrying:

```sh
node -e "const u=new URL(process.env.DATABASE_URL); console.log('host:',u.hostname,'port:',u.port,'user:',u.username)"
```
