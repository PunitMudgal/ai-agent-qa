# How to Use the QA Test Case Generator

This guide shows how to use the tool **with the UI and CLI**, using **Swagger/OpenAPI** and/or **Routes directory**, with a concrete example for a backend project (e.g. `QLS-Backend` at `/Users/punit/projects/QLS-Backend`).

---

## Prerequisites

1. **Node.js** (v16+).
2. **Groq API key** (free at [console.groq.com](https://console.groq.com)).
3. In the **ai-agent-qa** project root, copy `.env.example` to `.env` and set:
   ```bash
   GROQ_API_KEY=your_actual_groq_api_key_here
   ```

---

## Using with your backend project (e.g. QLS-Backend)

Assume your backend repo is at:

- **Project path:** `/Users/punit/projects/QLS-Backend`
- **Routes folder:** e.g. `/Users/punit/projects/QLS-Backend/src/routes` or `.../routes`
- **Controllers folder (optional):** e.g. `/Users/punit/projects/QLS-Backend/src/controllers`
- **Swagger file (if any):** e.g. `/Users/punit/projects/QLS-Backend/swagger.json` or `openapi.yaml`

You can use **Swagger only**, **Routes only**, or **both** (Swagger + Routes). Routes are parsed from Express-style files (e.g. `router.get('/path', handler)`).

---

## Option A: Web UI

### Step 1: Start the server

From the **ai-agent-qa** project directory:

```bash
cd "/Users/punit/test-projects/test case generator/ai-agent-qa"
npm start
```

Open **http://localhost:3000** in your browser.

### Step 2: Choose input source

- **Swagger only:** Use the **“Swagger File”** tab to upload a `.json`/`.yaml`/`.yml` file, or the **“Paste Content”** tab to paste Swagger/OpenAPI JSON or YAML.
- **Routes only:** Leave Swagger empty and use the **Routes directory path** field (see below).
- **Both:** Upload or paste Swagger **and** fill in the Routes path (and optionally Controllers path).

### Step 3: Routes directory path (optional)

In the left panel you’ll see:

- **Routes directory path**  
  Enter the **absolute path** to your backend’s route folder, e.g.  
  ` /Users/punit/projects/QLS-Backend/src/routes `
- **Controllers directory path** (optional)  
  e.g. ` /Users/punit/projects/QLS-Backend/src/controllers `

The server runs on your machine, so these local paths are valid.

### Step 4: Generate

- Optionally add **Business requirements** and open **Advanced options** (format, min tests, filters).
- Click **Generate Test Cases**. Results appear on the right; you can copy or download JSON/Markdown.

**Summary:**

| You have              | What to do in UI                                                                 |
|-----------------------|-----------------------------------------------------------------------------------|
| Swagger file only     | Upload or paste Swagger; leave Routes path empty.                                 |
| Routes folder only    | Leave Swagger empty; set **Routes directory path** to your backend routes folder.|
| Swagger + Routes      | Upload/paste Swagger **and** set **Routes directory path** (and controllers if desired). |

---

## Option B: CLI

All commands are run from the **ai-agent-qa** project directory:

```bash
cd "/Users/punit/test-projects/test case generator/ai-agent-qa"
```

### 1. From Swagger file only

```bash
node src/cli.js swagger --input /Users/punit/projects/QLS-Backend/swagger.json --output ./output
```

Or with a local sample:

```bash
node src/cli.js swagger --input tests/sample.swagger.json --output ./output
```

Optional: `--format json|markdown|both`, `--min-tests 10`, `--context "your business rules"`, `--filter-tags users,auth`, `--filter-paths /api/users`.

### 2. From Routes directory only

```bash
node src/cli.js routes --routes /Users/punit/projects/QLS-Backend/src/routes --output ./output
```

With controllers (optional):

```bash
node src/cli.js routes \
  --routes /Users/punit/projects/QLS-Backend/src/routes \
  --controllers /Users/punit/projects/QLS-Backend/src/controllers \
  --output ./output
```

### 3. From both Swagger and Routes (mixed)

```bash
node src/cli.js generate \
  --swagger /Users/punit/projects/QLS-Backend/swagger.json \
  --routes /Users/punit/projects/QLS-Backend/src/routes \
  --controllers /Users/punit/projects/QLS-Backend/src/controllers \
  --output ./output
```

You can pass only `--swagger`, only `--routes`, or both. Same global options as above (`--format`, `--min-tests`, etc.).

### 4. Auto-detect (scan project)

Point at your **backend** project root; the CLI will look for Swagger and route files and run mixed generation:

```bash
node src/cli.js scan --project /Users/punit/projects/QLS-Backend --output ./output
```

### 5. Interactive mode

Prompts for Swagger path, routes dir, controllers dir, context, format, output dir:

```bash
node src/cli.js interactive
```

### 6. Other CLI commands

- **Validate** generated test JSON:  
  `node src/cli.js validate --input ./output/qa_test_cases_xxx.json`
- **Stats** for a generated file:  
  `node src/cli.js stats --input ./output/qa_test_cases_xxx.json`

---

## Quick reference: QLS-Backend example

| Goal                    | UI                                                                 | CLI |
|-------------------------|--------------------------------------------------------------------|-----|
| Swagger only            | Upload/paste Swagger; Generate                                     | `node src/cli.js swagger --input /Users/punit/projects/QLS-Backend/swagger.json` |
| Routes only             | Set Routes path = `/Users/punit/projects/QLS-Backend/src/routes`; Generate | `node src/cli.js routes --routes /Users/punit/projects/QLS-Backend/src/routes` |
| Swagger + Routes        | Upload/paste Swagger + set Routes path; Generate                   | `node src/cli.js generate --swagger /path/to/swagger.json --routes /Users/punit/projects/QLS-Backend/src/routes` |
| Auto-detect in project  | N/A (CLI only)                                                    | `node src/cli.js scan --project /Users/punit/projects/QLS-Backend` |

Output is written to `./output` (or the directory you set via **Output directory** in the UI or `--output` in the CLI).
