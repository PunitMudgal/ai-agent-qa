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
cd qa-generator
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

# Generate from Swagger file
node dist/cli.js swagger --input tests/sample.swagger.json --format both --verbose

# See all commands
node dist/cli.js --help
```

### 4. Use the Web UI

```bash
npm start
# Open http://localhost:3000
```

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
qa-generator/
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
| `GROQ_API_KEY` | Groq API key (required) | — |
| `GROQ_MODEL` | AI model name | `llama-3.3-70b-versatile` |
| `PORT` | Web server port | `3000` |
| `DEFAULT_MIN_TESTS_PER_ENDPOINT` | Min test cases per endpoint | `10` |
| `DEFAULT_OUTPUT_DIR` | Output directory | `./output` |
| `DEFAULT_FORMAT` | Default output format | `both` |
| `LOG_LEVEL` | Logging level | `info` |

---

## 🔑 Getting a Groq API Key

1. Go to [console.groq.com](https://console.groq.com)
2. Sign up for a free account
3. Navigate to API Keys
4. Create a new API key
5. Copy the key to your `.env` file

The free tier includes generous rate limits for the `llama-3.3-70b-versatile` model.

---

## 📄 License

MIT
