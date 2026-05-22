# MCP SQL : HFSQL (ODBC), MySQL, Microsoft SQL Server

Serveur [MCP](https://modelcontextprotocol.io) en **HTTP streamable** (Express + `@modelcontextprotocol/sdk`), compatible Claude Desktop (`mcp-remote`), ChatGPT, Mistral, etc.

## Choix du moteur dans l’URL

| Paramètre   | Rôle |
|------------|------|
| `type`     | **`hfsql`** (défaut si absent), **`mysql`**, **`mssql`** (alias `sqlserver`). Valeur inconnue → erreur 400. |
| `token`    | Même secret que `API_KEY` (clients qui ne gèrent qu’une URL) |
| `name`     | Optionnel : **nom d’une connexion** déclarée dans `databases.json` pour ce `type` (ex. `name=flexi`). Nécessite le fichier JSON. |
| `database` | Optionnel : base MySQL / SQL Server (surcharge de la base indiquée dans le JSON ou le `.env`). Ignoré pour **HFSQL**. |

Exemples :

```txt
https://mon-domaine.com/mcp?token=SECRET&type=hfsql&name=flexi
https://mon-domaine.com/mcp?token=SECRET&type=mysql&name=local&database=autre_base
https://mon-domaine.com/mcp?token=SECRET&type=mssql&name=erp
http://192.168.1.10:3333/mcp?type=hfsql&token=SECRET
```

Sans `databases.json`, le repli se fait sur le **`.env`** (`HFSQL_DSN`, `MYSQL_*`, `MSSQL_*`) comme avant.

---

## Fichier `databases.json` (plusieurs bases par type)

1. Copie **`databases.example.json`** vers **`databases.json`** à la racine du projet (ou défini par **`MCP_DATABASES_FILE`** dans `.env`).
2. Structure :
   - **`defaults`** : connexion utilisée pour chaque `type` lorsque l’URL ne contient pas `name=` (ex. `"hfsql": "flexi"`).
   - **`databases`** : pour chaque moteur (`hfsql`, `mysql`, `mssql`), un objet **nom → paramètres** (DSN ou host/user/database, etc.).

Si un **`defaults.<type>`** est renseigné mais la clé est absente ou la section manque, le serveur renverra une erreur explicite pour ce `type`.

**Sécurité** : ne commite pas `databases.json` s’il contient des mots de passe (déjà listé dans `.gitignore`).

### Interface web (liste / édition / suppression)

- Ouvre **`http://localhost:PORT/admin?token=VOTRE_API_KEY`** (la clé est la même que **`API_KEY`** dans `.env`).
- Sans **`API_KEY`**, l’admin n’est pas activée (réponse 503).
- Actions : voir toutes les connexions par moteur, éditer les **defaults**, **ajouter** une connexion, **modifier**, **supprimer** (avec confirmation). **Enregistrer tout** écrit le fichier sur disque (validation Zod côté serveur).
- API : `GET /admin/api/config`, `PUT /admin/api/config` (corps = JSON complet), `DELETE /admin/api/connection/:type/:name`.

---

## Prérequis

- NODE JS 24 (https://nodejs.org/fr)
- GIT (https://git-scm.com/install)
- **HFSQL** : installation en local sur un PC Windows avec driver ODBC HFSQL (pcsoft.fr), Node.js.
- **MySQL / MSSQL** : Node.js ; accès réseau au serveur SQL ; variables d’environnement (voir `env.example`).

---

## HFSQL : source de données ODBC

Installer le Driver ODBC pour HFSQL (Windows)(https://download.windev.com/fr/download/neo/HFSQL/2026.awp)
Ouvre `odbcad32.exe` → Sources de données système → Ajouter → driver HFSQL :

* Nom (DSN) de ton choix
* Dossier `.wdd`, dossier fichiers, test de connexion

---

## Installation sur Windows

```cmd
C:
git clone  https://github.com/burotica49/MCP-SQL.git
cd C:\MCP-SQL
npm install
```

Copie `env.example` vers `.env` et, si besoin, **`databases.example.json`** vers **`databases.json`**. Tu peux n’utiliser que le `.env`, uniquement le JSON, ou les deux (JSON prioritaire quand `name=` ou `defaults` s’appliquent).

---

## Lancer le serveur

```cmd
npx tsx src/index.ts
```

ou `npm start`.

Test santé :

```cmd
curl http://localhost:3333/health
```

Réponse attendue : `{"status":"ok"}`

---

## Variables d’environnement (résumé)

Voir **`env.example`** pour la liste complète.

- **Commun** : `PORT`, `API_KEY`, `ALLOWED_IPS`, `MCP_DATABASES_FILE` (chemin optionnel vers le JSON)
- **HFSQL** : `HFSQL_DSN`
- **MySQL** : `MYSQL_HOST`, `MYSQL_PORT`, `MYSQL_USER`, `MYSQL_PASSWORD`, `MYSQL_DATABASE`
- **MSSQL** : `MSSQL_SERVER`, `MSSQL_PORT`, `MSSQL_USER`, `MSSQL_PASSWORD`, `MSSQL_DATABASE`, `MSSQL_ENCRYPT`, `MSSQL_TRUST_SERVER_CERTIFICATE`

---

## Service Windows (exemple tâche planifiée)

```cmd
schtasks /create /tn "SQL MCP Server" /tr "cmd /c cd /d C:\MCP-SQL && npx tsx src/index.ts >> C:\MCP-SQL\logs\output.log 2>&1" /sc onstart /ru SYSTEM /f
```

Commandes utiles :


```cmd
schtasks /run /tn "HFSQL MCP Server" # démarrer
schtasks /query /tn "HFSQL MCP Server" # statut
schtasks /end /tn "HFSQL MCP Server" # arrêter 
schtasks /delete /tn "HFSQL MCP Server" /f # supprimer
```


## Ouvrir le pare-feu Windows
Pare-feu (exemple port 3333) :

```cmd
netsh advfirewall firewall add rule name="SQL MCP" dir=in action=allow protocol=TCP localport=3333
```

---

## Claude Desktop (exemple)

Fichier `~/Library/Application Support/Claude/claude_desktop_config.json` :

```json
{
  "mcpServers": {
    "mysql-prod": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "http://192.168.xxx.xx:3333/mcp?type=mysql",
        "--allow-http",
        "--header",
        "x-api-key: un-secret-bien-choisi"
      ]
    }
  }
}
```

Adapter l’URL (`type=`, `database=` si besoin).

---

## Tunnel Cloudflare

Il faudra configurer un tunnel Cloudflare pour l'uitilser avec votre agent IA de n'impporte où
```txt
https://mon-domaine.com/mcp?token=SECRET&type=hfsql&name=flexi
```

---

## Outils MCP exposés

Les trois outils sont identiques quel que soit `type` :

- `list_tables` — liste des tables
- `describe_table` — colonnes (MySQL / MSSQL : possibilité `schema.table` pour MSSQL, `schema.table` pour MySQL hors base courante)
- `query` — **SELECT uniquement** ; limite : `TOP` (HFSQL, MSSQL), `LIMIT` (MySQL) sauf si la requête contient déjà un `LIMIT`

---

## Architecture

```
Client (Claude / ChatGPT / …)
    │
    ▼
Tunnel Cloudflare (option)
    │
    ▼
Express : /mcp?type=hfsql|mysql|mssql&token=…&name=…&database=…
    │
    ▼
Résolution : databases.json (optionnel) puis .env
    │
    ▼
Backend : hfsql-odbc.ts | mysql-backend.ts | mssql-backend.ts
    │
    ▼
HFSQL (.fic) / MySQL / SQL Server
```

Structure du code : `src/index.ts` (HTTP + MCP), `src/config/databases.ts` (schéma + chargement du JSON), `src/backends/` (types, factory, un fichier par moteur).
