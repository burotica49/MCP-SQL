/** Mots-clés interdits hors littéraux (lecture seule stricte). */
const FORBIDDEN_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|MERGE|REPLACE|EXEC(?:UTE)?|CALL|GRANT|REVOKE|DENY|OPENROWSET|OPENQUERY|BULK|BACKUP|RESTORE|SHUTDOWN|KILL|WAITFOR|LOAD_FILE|OUTFILE|INTO|xp_\w+|sp_\w+)\b/i;

const READ_ONLY_START = /^\s*(WITH\b[\s\S]+\bSELECT|SELECT)\b/i;

/** Retire les littéraux et identifiants entre crochets pour l’analyse des mots-clés. */
function stripLiteralsAndIdentifiers(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === "'" || ch === '"') {
      const quote = ch;
      out += "''";
      i++;
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (ch === "'" && sql[i] === "\\") {
          i += 2;
          continue;
        }
        i++;
      }
      continue;
    }
    if (ch === "[") {
      out += "[]";
      i++;
      while (i < sql.length) {
        if (sql[i] === "]") {
          if (sql[i + 1] === "]") {
            i += 2;
            continue;
          }
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Valide qu’une requête est un SELECT lecture seule (une seule instruction). */
export function assertReadOnlySelect(sql: string): void {
  const trimmed = sql.trim();
  if (!trimmed) {
    throw new Error("Requête SQL vide.");
  }
  if (trimmed.includes(";")) {
    throw new Error("Une seule instruction SQL autorisée (point-virgule interdit).");
  }
  if (/--|\/\*/.test(trimmed)) {
    throw new Error("Commentaires SQL interdits.");
  }

  const normalized = stripLiteralsAndIdentifiers(trimmed);
  if (!READ_ONLY_START.test(normalized)) {
    throw new Error(
      "Seules les requêtes SELECT (éventuellement précédées de WITH) sont autorisées."
    );
  }
  if (FORBIDDEN_KEYWORDS.test(normalized)) {
    throw new Error("Instruction non autorisée (lecture seule : SELECT uniquement).");
  }
}
