import { db, databasePath } from "../server/db.ts";
import { ensureSeeded, resetDemo } from "../server/seed.ts";

db();
ensureSeeded();
const r = resetDemo();
console.log(`Demo workspace reset in ${databasePath()} (replaced ${r.removed_projects} demo project(s)).`);
console.log("Data you created outside the demo project was not touched.");
