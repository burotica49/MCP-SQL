/**
 * Teste une connexion ODBC (ex. HFSQL) sans top-level await (compatible CJS / tsx).
 *
 * HFSQL ne gère pas bien `SELECT 1` (pseudo-table ###DUAL0###) : on utilise les
 * métadonnées ODBC `tables()` pour valider la connexion.
 *
 * Usage :
 *   npx tsx scripts/test-odbc.ts "DSN=Flexigestion"
 *   npx tsx scripts/test-odbc.ts          (utilise HFSQL_DSN dans .env)
 *
 * Optionnel — exécuter une requête SELECT sur une vraie table :
 *   npx tsx scripts/test-odbc.ts "DSN=Flexi" "SELECT TOP 1 * FROM MaTable"
 */
import "dotenv/config";
import odbc from "odbc";

const dsn = process.argv[2]?.trim() || process.env.HFSQL_DSN?.trim();
const optionalSql = process.argv[3]?.trim();

if (!dsn) {
  console.error(
    "Indique le DSN en argument ou définis HFSQL_DSN dans .env, ex. :\n" +
      '  npx tsx scripts/test-odbc.ts "DSN=Flexigestion"'
  );
  process.exit(1);
}

void (async () => {
  try {
    console.log("Connexion :", dsn.replace(/password=[^;]*/i, "password=***"));
    const c = await odbc.connect(dsn);

    console.log("Test métadonnées : liste des tables (ODBC)…");
    const tables = await c.tables(null, null, null, "TABLE");
    const names = (tables as { TABLE_NAME?: string }[])
      .map((t) => t.TABLE_NAME)
      .filter((n): n is string => Boolean(n));
    console.log("Nombre de tables :", names.length);
    console.log("Exemples :", names.slice(0, 8).join(", ") || "(aucune)");

    if (optionalSql) {
      if (!/^\s*select/i.test(optionalSql)) {
        console.error("Le 2e argument doit être un SELECT uniquement.");
        process.exit(1);
      }
      console.log("Requête optionnelle :", optionalSql.slice(0, 120) + (optionalSql.length > 120 ? "…" : ""));
      const rows = await c.query(optionalSql);
      console.log("Lignes retournées :", Array.isArray(rows) ? rows.length : "?", rows);
    }

    await c.close();
    console.log("OK — ODBC / HFSQL répond.");
  } catch (e) {
    console.error("Échec ODBC :", e);
    process.exit(1);
  }
})();
