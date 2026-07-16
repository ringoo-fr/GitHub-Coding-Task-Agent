# 🤖 GitHub Task Agent

An autonomous coding agent powered by Claude. It monitors a GitHub repository for issues labeled `agent-task`, attempts to resolve them by modifying code, and opens a **draft pull request** for human review — or posts a comment explaining why it got stuck.

**Nothing is merged automatically. Every change lands as a draft PR.**

---

## How it works

```
GitHub Issues (labeled "agent-task")
           ↓
   Pick oldest unprocessed issue
           ↓
   Clone / update local repo
           ↓
   Claude agent explores codebase
   ├─► list_files   — understand structure
   ├─► read_file    — read relevant files
   ├─► search_code  — find references
   ├─► write_file   — implement the fix
   └─► run_command  — verify with tests
           ↓
   ┌── outcome: fix ──────────────────────────┐
   │   Commit changes → push branch           │
   │   Open DRAFT pull request (human review) │
   └──────────────────────────────────────────┘
   ┌── outcome: blocked ──────────────────────┐
   │   Post comment on issue explaining       │
   │   what was attempted and what's needed   │
   └──────────────────────────────────────────┘
           ↓
   Log everything to logs/run-<id>.log
```

---

## Setup

### 1. Install dependencies

```bash
cd github-task-agent
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
ANTHROPIC_API_KEY=your-anthropic-key
GITHUB_TOKEN=your-github-pat
GITHUB_REPO_OWNER=your-org-or-username
GITHUB_REPO_NAME=your-repo-name
```

### 3. Create a GitHub PAT

Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**

Permissions needed:
| Permission | Access |
|---|---|
| Issues | Read & Write |
| Pull requests | Read & Write |
| Contents | Read & Write |
| Metadata | Read-only |

### 4. Label an issue

On your target repo, add the label `agent-task` to any open issue you want the agent to pick up.

---

## Usage

```bash
# Auto-pick the oldest unprocessed agent-task issue
node index.js

# Target a specific repo
node index.js --repo owner/repo

# Target a specific issue number
node index.js --issue 42

# Use a different label
node index.js --label ai-fix

# Use a faster/cheaper model
node index.js --model claude-sonnet-4-5
```

---

## Output

### Draft PR (if fix was made)
Opens a draft PR on GitHub with:
- Link back to the original issue
- Summary of what was changed and why
- List of files modified
- Review checklist for the human reviewer

### Issue comment (if blocked)
Posts a comment explaining:
- What the agent attempted
- What prevented a full fix
- What a human needs to do next

### Log file (`./logs/`)
Every run produces `logs/run-<timestamp>.log` with:
- Issue picked (number, title, URL)
- Every file read/written
- Search queries run
- Commands executed and their output
- PR or comment URL
- Total time taken

---

## Project structure

```
github-task-agent/
├── index.js                   # CLI entry point + orchestration
├── src/
│   ├── agent.js               # Claude tool-use agent loop
│   ├── logger.js              # Step logger
│   ├── github/
│   │   ├── client.js          # Authenticated Octokit instance
│   │   ├── issues.js          # Fetch issues, post comments, add labels
│   │   ├── repo.js            # Clone, branch, commit, push
│   │   └── pr.js              # Open draft pull requests
│   └── tools/
│       └── registry.js        # Tool definitions + executor
│                              #  (read_file, write_file, list_files,
│                              #   search_code, run_command, produce_result)
├── logs/                      # Per-run action logs
└── workspace/                 # Cloned repos (gitignored)
```

---

## Safety design

| Concern | How it's handled |
|---|---|
| Auto-merge | ❌ Disabled — all output is a **draft PR** |
| Secret leaks | `.env` is gitignored; PAT embedded only in clone URL at runtime |
| Runaway changes | `produce_result` is required to end the loop; max 30 turns |
| Duplicate runs | Agent marker embedded in comments; already-processed issues are skipped |
| Repo corruption | Agent works on a dedicated branch; `resetToMain()` called after each run |

---

## Configuration reference

| Variable | Required | Default | Description |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | ✅ | — | Anthropic API key |
| `GITHUB_TOKEN` | ✅ | — | GitHub PAT |
| `GITHUB_REPO_OWNER` | ✅ | — | Repo owner/org |
| `GITHUB_REPO_NAME` | ✅ | — | Repo name |
| `ISSUE_LABEL` | ❌ | `agent-task` | Label to filter issues |
| `CLAUDE_MODEL` | ❌ | `claude-opus-4-5` | Model override |
| `BRANCH_PREFIX` | ❌ | `agent-fix` | Prefix for fix branches |
| `WORKSPACE_DIR` | ❌ | `./workspace` | Where repos are cloned |
