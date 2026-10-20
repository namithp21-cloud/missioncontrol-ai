import { db, databasePath, migrate } from "../server/db.ts";
import { ensureSeeded } from "../server/seed.ts";

const conn = db(); // opening the database also applies pending migrations
const ran = migrate(conn); // no-op here; prints nothing new
const seeded = ensureSeeded();
console.log(`Database ready at ${databasePath()}`);
console.log(seeded ? "Demo workspace seeded (first run)." : "Demo workspace already present; left untouched.");
void ran;
