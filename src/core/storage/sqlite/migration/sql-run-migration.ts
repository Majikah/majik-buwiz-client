// import { MIGRATIONS } from "./sql-migrations";
// import { type Promiser } from "@sqlite.org/sqlite-wasm";
// /**
//  * Runs all pending migrations against the given promiser/dbId pair.
//  * Safe to call on every app start — skips already-applied versions.
//  */
// export async function runMigrations(
//   promiser: Promiser,
//   dbId: string,
// ): Promise<void> {
//   // Read current schema version
//   const versionResult = await promiser("exec", {
//     dbId,
//     sql: "PRAGMA user_version;",
//     returnValue: "resultRows",

//   });

//   const currentVersion: number =
//     versionResult.result.resultRows?.[0]?.user_version ?? 0;

//   console.debug(`[migrations] DB is at version ${currentVersion}`);

//   const pending = MIGRATIONS.filter((m) => m.version > currentVersion).sort(
//     (a, b) => a.version - b.version,
//   );

//   if (pending.length === 0) {
//     console.debug("[migrations] No pending migrations.");
//     return;
//   }

//   for (const migration of pending) {
//     console.debug(
//       `[migrations] Applying v${migration.version}: ${migration.description}`,
//     );

//     try {
//       await promiser("exec", { dbId, sql: migration.sql });

//       // Bump user_version — must use string interpolation, not bind params
//       await promiser("exec", {
//         dbId,
//         sql: `PRAGMA user_version = ${migration.version};`,
//       });

//       console.debug(`[migrations] v${migration.version} applied.`);
//     } catch (err: any) {
//       console.error(
//         `[migrations] Failed at v${migration.version}:`,
//         err.message,
//       );
//       throw err; // Halt — don't apply further migrations on a broken state
//     }
//   }

//   console.debug(
//     `[migrations] Done. DB now at version ${pending.at(-1)!.version}`,
//   );
// }
