# ai-agent-qa — Command reference (use in another repo)

Run these from your **backend repo root** after installing ai-agent-qa (`npm link ai-agent-qa` or `npm install --save-dev ai-agent-qa` or `file:...`). Paths are relative to that repo.

**Prerequisite:** In the backend repo root, add to `.env`:
```bash
GROQ_API_KEY=your_key   # or GEMINI_API_KEY
```

---

## 1. Generate from Swagger/OpenAPI only

```bash
# Basic — JSON output to ./output
npx ai-agent-qa swagger --input ./swagger.json

# With output directory and format
npx ai-agent-qa swagger --input ./swagger.json --output ./tests/qa --format both

# With business context
npx ai-agent-qa swagger --input ./openapi.yaml --context "Users must verify email before purchasing" --output ./output

# Filter by Swagger tags (comma-separated)
npx ai-agent-qa swagger --input ./swagger.json --filter-tags users,auth,products --output ./output

# Filter by endpoint paths (comma-separated)
npx ai-agent-qa swagger --input ./swagger.json --filter-paths /users,/auth/login,/api/v1/orders --output ./output

# Tags + paths + context + format
npx ai-agent-qa swagger --input ./swagger.json \
  --filter-tags users,orders \
  --filter-paths /users,/orders \
  --context "Subscription required for premium endpoints" \
  --format both --output ./output --verbose
```

---

## 2. Generate from routes and controllers only

```bash
# Routes only
npx ai-agent-qa routes --routes ./src/routes --output ./output

# Routes + controllers
npx ai-agent-qa routes --routes ./src/routes --controllers ./src/controllers --output ./output

# With format and context
npx ai-agent-qa routes --routes ./src/routes --controllers ./src/controllers \
  --output ./output --format both --context "All write ops require admin role"
```

**Note:** `--filter-tags` and `--filter-paths` apply to both Swagger and routes. For routes-only, tags are inferred from the route filename (e.g. `auth.routes.js` → tag `auth`), and path filters match by the last path segment to filename (e.g. `/api/v1/auth` matches routes from `auth.routes.js`).

---

## 3. Generate from both Swagger and routes/controllers (mixed)

```bash
# Explicit swagger + routes + controllers
npx ai-agent-qa generate \
  --swagger ./swagger.json \
  --routes ./src/routes \
  --controllers ./src/controllers \
  --output ./output --format both

# With filters (apply to Swagger part)
npx ai-agent-qa generate \
  --swagger ./swagger.json \
  --routes ./src/routes \
  --controllers ./src/controllers \
  --filter-tags users,auth \
  --filter-paths /users,/auth \
  --output ./output
```

---

## 4. Auto-detect project (scan)

Finds Swagger and route files under the project directory.

```bash
# Scan current directory
npx ai-agent-qa scan --project . --output ./output

# With format
npx ai-agent-qa scan --project . --output ./output --format both

# With filters (for Swagger part)
npx ai-agent-qa scan --project . --filter-tags users,orders --filter-paths /api/users,/api/orders --output ./output
```

---

## 5. Generate Jest + Supertest test files

Add `--jest` to any of the above. Optionally set Jest output dir, base URL, and base path.

```bash
# Swagger → test cases + Jest tests (default: ./output/jest, base URL http://localhost:3000)
npx ai-agent-qa swagger --input ./swagger.json --output ./output --jest

# Custom Jest directory and base URL
npx ai-agent-qa swagger --input ./swagger.json --output ./output \
  --jest --jest-dir ./tests/api --base-url http://localhost:4000

# If your app mounts routes under /api/v1
npx ai-agent-qa routes --routes ./src/routes --output ./output \
  --jest --base-path /api/v1 --base-url http://localhost:3000

# Swagger + filters + Jest
npx ai-agent-qa swagger --input ./swagger.json \
  --filter-tags users --filter-paths /users,/users/:id \
  --output ./output --jest --jest-dir ./tests/qa

# Scan project + Jest
npx ai-agent-qa scan --project . --output ./output --jest --jest-dir ./tests/qa --base-url http://localhost:3000

# Strict body assertions (default is status-only to avoid false failures)
npx ai-agent-qa swagger --input ./swagger.json --output ./output --jest --strict-assertions
```

| Option | Description | Default |
|--------|-------------|--------|
| `--jest` | Also generate Jest + Supertest `.test.ts` files | off |
| `--jest-dir <path>` | Directory for Jest files | `<output>/jest` |
| `--base-url <url>` | API base URL in tests | `http://localhost:3000` |
| `--base-path <path>` | Route prefix (e.g. `/api/v1`) | — |
| `--strict-assertions` | Strict body assertions; default is status-only | off |

---

## 6. Filter options (Swagger/OpenAPI)

| Option | Description | Example |
|--------|-------------|--------|
| `--filter-tags <tags>` | Only include operations with these Swagger tags | `--filter-tags users,auth,orders` |
| `--filter-paths <paths>` | Only include these paths (exact or prefix) | `--filter-paths /users,/auth/login` |

Use with: `swagger`, `generate`, or `scan` (when Swagger is used).

---

## 7. Other useful options (all commands)

| Option | Description | Default |
|--------|-------------|--------|
| `--output <dir>` | Output directory for JSON/Markdown | `./output` |
| `--format <type>` | `json`, `markdown`, or `both` | `json` |
| `--min-tests <n>` | Minimum test cases per endpoint | `10` |
| `--context <string>` | Business requirements / context for AI | — |
| `--verbose` | Detailed logs | false |
| `--quiet` | Only errors | false |
| `--no-color` | Disable colors | false |

---

## 8. Utility commands

```bash
# Validate generated JSON
npx ai-agent-qa validate --input ./output/qa_test_cases_xxx.json

# Stats for generated file
npx ai-agent-qa stats --input ./output/qa_test_cases_xxx.json

# Interactive (prompts for paths)
npx ai-agent-qa interactive
```

---

## 9. Quick copy-paste (another repo)

**Swagger only, output to ./output:**
```bash
npx ai-agent-qa swagger --input ./swagger.json --output ./output
```

**Routes + controllers, output to ./output:**
```bash
npx ai-agent-qa routes --routes ./src/routes --controllers ./src/controllers --output ./output
```

**Swagger + filter tags & paths:**
```bash
npx ai-agent-qa swagger --input ./swagger.json --filter-tags users,auth --filter-paths /users,/auth --output ./output
```

**Generate Jest tests (Swagger):**
```bash
npx ai-agent-qa swagger --input ./swagger.json --output ./output --jest --jest-dir ./tests/qa --base-url http://localhost:3000
```

**Generate Jest tests (routes + controllers):**
```bash
npx ai-agent-qa routes --routes ./src/routes --controllers ./src/controllers --output ./output --jest --base-path /api/v1
```

**Full: Swagger + routes + filters + Jest:**
```bash
npx ai-agent-qa generate \
  --swagger ./swagger.json --routes ./src/routes --controllers ./src/controllers \
  --filter-tags users,orders --filter-paths /users,/orders \
  --output ./output --format both --jest --jest-dir ./tests/qa
```
