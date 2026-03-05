# 🤖 QA Test Case Generator

AI-powered QA test case generator for Node.js backend projects. Generate comprehensive test cases from Swagger/OpenAPI specs, Express route files, and controller logic using **Groq AI** (Llama 3.3 70B).

Works as both a **CLI tool** and a **Web UI**.

---

## ✨ Features

- **Swagger/OpenAPI Parsing** — Supports both OpenAPI 3.0 and Swagger 2.0 (JSON & YAML)
- **Express Route Scanning** — Auto-detects routes, middleware, and controller references
- **Controller Analysis** — Extracts business logic hints: error handling, auth checks, status codes
- **AI-Powered Generation** — Uses Groq's free Llama 3.3 70B model for intelligent test case creation
- **5 Test Categories** — Positive, Negative, Edge Cases, Validation, Boundary Conditions
- **Multiple Output Formats** — JSON with metadata and formatted Markdown
- **Web UI** — Beautiful dark-themed interface for the whole team
- **CLI** — 7 commands with filtering, progress bars, and colored output

---

## 🚀 Quick Start

### 1. Install

```bash
cd ai-agent-qa
npm install
```

### 2. Configure API Key

```bash
cp .env.example .env
# Edit .env and add your Groq API key (free at console.groq.com)
```

### 3. Use the CLI

```bash
npm run build   # Compile TypeScript first (required)

# Generate from Swagger file (from this repo)
node dist/cli.js swagger --input tests/sample.swagger.json --format both --verbose
# Or after npm link / install elsewhere:  ai-agent-qa swagger --input ./swagger.json ...

# See all commands
node dist/cli.js --help
```

### 4. Use the Web UI

```bash
npm start
# Open http://localhost:3000
```

---

## 📦 Use in any backend project (install as CLI)

You can install this tool in **any** backend repo and run test generation from that repo’s root via the CLI.

### Option 1: npm link (use from any repo without adding to package.json)

Best for trying the tool in multiple backends or developing the generator: link once, then run `npx ai-agent-qa` (or `ai-agent-qa`) from any backend.

**One-time setup in ai-agent-qa:**

```bash
cd "/path/to/ai-agent-qa"
npm install
npm run build
npm link
```

**In each backend repo where you want to use it:**

```bash
cd "/path/to/your-backend"
npm link ai-agent-qa
```

That’s it. The backend’s `node_modules` now points to your local ai-agent-qa, so you can run:

```bash
# From your backend repo root
npx ai-agent-qa scan --project . --output ./output
# or
ai-agent-qa swagger --input ./swagger.json --output ./output
```

**API key:** Put `GROQ_API_KEY=...` in the **backend repo’s** `.env` (the CLI loads `.env` from the directory where you run the command).

**Rebuilding after changes:** When you change ai-agent-qa code, run `npm run build` in the ai-agent-qa folder; all linked backends will use the updated CLI. No need to re-run `npm link` in the backends.

**Unlink from a backend:** `npm unlink ai-agent-qa` in that backend repo.

### Option 2: Install from local path (e.g. same machine)

**Step 1 — In your backend repo, add the dependency**

From your backend project root (e.g. `~/projects/my-backend`):

```bash
# Replace with the actual path to ai-agent-qa on your machine
npm install --save-dev file:/Users/punit/test-projects/test\ case\ generator/ai-agent-qa
```

Or add this to your backend’s `package.json` and run `npm install`:

```json
{
  "devDependencies": {
    "ai-agent-qa": "file:../path/to/ai-agent-qa"
  }
}
```

**Step 2 — Configure API key in the backend repo**

The CLI loads `.env` from the **current working directory** (your backend repo). So in your backend repo root, create or edit `.env` and add at least one key:

```bash
# In your backend repo root
echo "GROQ_API_KEY=your_groq_api_key_here" >> .env
# Optional fallback:
# echo "GEMINI_API_KEY=your_gemini_key" >> .env
```

Get a free Groq key at [console.groq.com](https://console.groq.com).

**Step 3 — Run the CLI from your backend repo**

All paths are relative to your backend repo root.

```bash
# From your backend repo root

# Swagger/OpenAPI only
npx ai-agent-qa swagger --input ./swagger.json --output ./output

# Express routes only
npx ai-agent-qa routes --routes ./src/routes --controllers ./src/controllers --output ./output

# Auto-detect Swagger + routes in current project
npx ai-agent-qa scan --project . --output ./output

# With Jest + Supertest test files
npx ai-agent-qa scan --project . --output ./output --jest --jest-dir ./tests/qa --base-url http://localhost:3000
```

**Step 4 (optional) — Add npm scripts in your backend**

In your backend’s `package.json`:

```json
{
  "scripts": {
    "qa:generate": "ai-agent-qa scan --project . --output ./output",
    "qa:swagger": "ai-agent-qa swagger --input ./swagger.json --output ./output",
    "qa:jest": "ai-agent-qa scan --project . --output ./output --jest --jest-dir ./tests/qa"
  }
}
```

Then run: `npm run qa:generate`, `npm run qa:swagger`, or `npm run qa:jest`.

### Option 3: Publish to npm and install by name

**Step 1 — Publish (one-time, from ai-agent-qa repo)**

```bash
cd "/path/to/ai-agent-qa"
npm run build
npm publish
```

(Use `npm publish --access public` for a scoped package like `@yourname/ai-agent-qa`.)

**Step 2 — In your backend repo**

```bash
npm install --save-dev ai-agent-qa
```

**Step 3 — Same as Option 1:** add `GROQ_API_KEY` (or `GEMINI_API_KEY`) to your backend’s `.env`, then run `npx ai-agent-qa ...` or add scripts as above.

### Summary

| How you installed | Run from backend repo |
|-------------------|------------------------|
| **npm link** | `npm link ai-agent-qa` once in backend → then `npx ai-agent-qa scan --project . --output ./output` (or `ai-agent-qa ...`) |
| **file:** or **npm** | `npm install --save-dev file:/path/to/ai-agent-qa` or `ai-agent-qa` → same `npx ai-agent-qa ...` commands |

In all cases: put `GROQ_API_KEY=...` in the **backend repo’s** `.env`. Paths (e.g. `--input`, `--output`, `--project`) are relative to where you run the command.

The tool resolves all paths (e.g. `--input`, `--output`, `--routes`, `--project`) relative to the directory where you run the command (your backend repo), so you can use relative paths like `./swagger.json` and `./src/routes`.

**→ Full command reference for another repo:** [COMMANDS.md](./COMMANDS.md) — Swagger, routes+controllers, Jest, filter by tags/paths, and copy-paste examples.

---

## 📖 CLI Commands

### `swagger` — Generate from Swagger/OpenAPI file
```bash
node dist/cli.js swagger --input ./swagger.json
node dist/cli.js swagger --input ./api.yaml --format markdown
node dist/cli.js swagger --input ./swagger.json --format both --output ./tests/
node dist/cli.js swagger --input ./swagger.json --context "Users must verify email before purchasing"
node dist/cli.js swagger --input ./swagger.json --filter-tags users,products
node dist/cli.js swagger --input ./swagger.json --filter-paths /users,/auth
```

### `routes` — Generate from Express routes + controllers
```bash
node dist/cli.js routes --routes ./src/routes/ --controllers ./src/controllers/
node dist/cli.js routes --routes ./src/routes/ --format markdown
```

### `generate` — Generate from all sources combined
```bash
node dist/cli.js generate --swagger ./swagger.json --routes ./src/routes/ --controllers ./src/controllers/ --format both
```

### `scan` — Auto-detect project sources
```bash
node dist/cli.js scan --project ./ --format both
```

### `interactive` — Interactive mode
```bash
node dist/cli.js interactive
```

### `validate` — Validate test case JSON
```bash
node dist/cli.js validate --input ./output/test-cases.json
```

### `stats` — Show test case statistics
```bash
node dist/cli.js stats --input ./output/test-cases.json
```

### Global Flags
| Flag | Description | Default |
|------|-------------|---------|
| `--format` | `json`, `markdown`, or `both` | `json` |
| `--output` | Output directory | `./output` |
| `--verbose` | Show detailed logs | `false` |
| `--quiet` | Suppress all output except errors | `false` |
| `--no-color` | Disable colored output | `false` |
| `--min-tests` | Min tests per endpoint | `10` |
| `--context` | Business requirements description | — |
| `--filter-tags` | Comma-separated swagger tags | — |
| `--filter-paths` | Comma-separated paths to include | — |

---

## 🌐 Web UI

Start the server with `npm start` and open `http://localhost:3000`.

**Features:**
- Drag-and-drop file upload (`.json`, `.yaml`, `.yml`)
- Paste Swagger content directly
- Business context input
- Advanced filtering options
- Real-time generation progress
- Preview table with color-coded categories
- JSON and Markdown output views
- Copy to clipboard and download buttons
- Generation history
- Keyboard shortcut: `Ctrl+Enter` to generate

---

## 📁 Project Structure

```
ai-agent-qa/
├── src/
│   ├── parsers/           # Input parsing modules
│   │   ├── swaggerParser.js
│   │   ├── routeParser.js
│   │   └── controllerParser.js
│   ├── ai/                # AI integration
│   │   ├── groqClient.js
│   │   └── promptBuilder.js
│   ├── generators/        # Test case orchestration
│   │   └── testCaseGenerator.js
│   ├── formatters/        # Output formatting
│   │   ├── jsonFormatter.js
│   │   └── markdownFormatter.js
│   ├── utils/             # Utilities
│   │   ├── fileUtils.js
│   │   └── logger.js
│   ├── cli.js             # CLI entry point
│   └── server.js          # Express web server
├── ui/
│   └── index.html         # Web UI (single file)
├── output/                # Generated test cases
├── tests/
│   └── sample.swagger.json
├── .env.example
├── package.json
└── README.md
```

---

## 📋 Output Format

### Test Case Schema
```json
{
  "id": "TC-001",
  "endpoint": "POST /users",
  "method": "POST",
  "scenario": "Valid registration with all required fields",
  "category": "positive",
  "priority": "high",
  "inputData": {
    "headers": { "Content-Type": "application/json" },
    "pathParams": {},
    "queryParams": {},
    "body": { "email": "test@example.com", "password": "Str0ng!Pass" }
  },
  "expectedOutput": {
    "statusCode": 201,
    "bodyContains": { "accessToken": "string" },
    "bodyExcludes": ["password"],
    "headers": {}
  },
  "preconditions": "No existing user with this email",
  "notes": "Happy path test",
  "status": "Pending"
}
```

---

## ⚙️ Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `GROQ_API_KEY` | Groq API key (primary) | — |
| `GROQ_MODEL` | Groq model name | `llama-3.3-70b-versatile` |
| `GEMINI_API_KEY` | Google Gemini key (fallback when Groq limit reached) | — |
| `GEMINI_MODEL` | Gemini model name | `gemini-2.0-flash` |
| `PORT` | Web server port | `3000` |
| `DEFAULT_MIN_TESTS_PER_ENDPOINT` | Min test cases per endpoint | `10` |
| `DEFAULT_OUTPUT_DIR` | Output directory | `./output` |
| `DEFAULT_FORMAT` | Default output format | `both` |
| `LOG_LEVEL` | Logging level | `info` |

---

## 🔑 Getting API Keys

At least one of these is required:

**Groq (primary):** [console.groq.com](https://console.groq.com) — free tier with generous limits.

**Google Gemini (fallback):** [aistudio.google.com/apikey](https://aistudio.google.com/apikey) — used when Groq daily limit is reached or Groq is not configured.

---

## 📄 License

MIT
