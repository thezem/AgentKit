Claude Code’s CLI delivers a **developer‑centric, agentic UX** inside the terminal: it feels like pairing with a very opinionated, file‑aware engineering partner that can read, edit, and execute code and shell commands, while giving you tight feedback and control over what it does. [anthropic](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)

Below is a high‑fidelity description of the UX: what you can do, how the UI behaves, what waits on what, and the end‑to‑end workflow.

---

### 1. Getting started and setup UX

- **Installation & auth**
  - You install via a package manager (e.g., `npm install -g @anthropic/claude-code`) and then run `claude auth login` to sign in with your Anthropic account or console‑based API billing. [code.claude](https://code.claude.com/docs/en/cli-reference)
  - The UX is a short, text‑based flow: the CLI prompts you to open a browser, paste a link, or authenticate with SSO, then prints a success message and stores credentials in a config file. [code.claude](https://code.claude.com/docs/en/cli-reference)

- **Bootstrapping a project**
  - You `cd` into a codebase and run `claude` (or `claude work`) to start the “agent” session.
  - On first run, the CLI shows a brief onboarding paragraph explaining tools, permissions, and how it will scan the repo (e.g., which files it can read/write and which it excludes via `.claudeignore`). [blakecrosley](https://blakecrosley.com/guides/claude-code)

UX behavior:

- Input is fully keyboard‑driven; no mouse‑click interactions.
- The CLI prints a banner with version, project root, and current agent status (e.g., “Agent ready at ~/my‑project”). [anthropic](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)

---

### 2. What users can do in the CLI

Once started, the CLI presents a **prompt‑and‑tool‑loop interface** where you describe a task and Claude decides what actions to take (read files, edit, run commands, ask questions). [blakecrosley](https://blakecrosley.com/guides/claude-code)

Typical actions you can instruct it to do:

- **Read & understand code**
  - Example: “Explain how the auth middleware works in this repo.”
  - The UX: Claude lists the files it will inspect, then either prints a high‑level summary or walks through specific functions. [blakecrosley](https://blakecrosley.com/en/guides/claude-code)

- **Edit and refactor code**
  - Example: “Refactor this React component to use hooks and remove class‑style logic.”
  - The UX:
    1. Claude proposes a diff (inline or via `git diff`‑style rendering).
    2. You can hit `y` (accept), `n` (reject), or `e` (edit the diff in your editor).
    3. On acceptance, it writes the file, commits changes via internal git tooling (if configured), and prints the new file path and key changes. [anthropic](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)

- **Run tests/build commands**
  - Example: “Run the test suite and fix any failing tests.”
  - The UX:
    - Claude runs `npm test` or whatever is in your `.claode` config and shows the stdout in real time (with color if your terminal supports it).
    - If tests fail, it will analyze the errors, propose patches, and again ask you to review or accept them. [blakecrosley](https://blakecrosley.com/guides/claude-code)

- **Navigate and search the project**
  - Example: “Find all API routes that handle user deletion.”
  - The UX:
    - Claude lists matching files, then offers to open a few at a time for you to skim in the terminal (or via `--editor` if you’ve bound one).
    - You can also trigger interactive search overlays similar to `fzf` or `Ctrl+R`‑style history. [blakecrosley](https://blakecrosley.com/en/guides/claude-code)

- **Use external tools / MCP integrations**
  - Claude Code can invoke tools such as GitHub APIs, databases, or other services configured via the **MCP (Model‑Controlled Program)** layer. [anthropic](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)
  - UX: when it needs to call an external service, it prints a one‑line explanation (e.g., “Fetching GitHub pull request info for PR #123”) and shows the result as a structured snippet (JSON‑like, highlighted). You can then say “continue”, “edit”, or “stop”. [blakecrosley](https://blakecrosley.com/guides/claude-code)

---

### 3. How the UI behaves and what waits on what

The CLI UI is **modal and sequential**, not instant‑messaging: it waits for the agent to finish an action block before returning control to you, but you can interrupt it.

Key behaviors:

- **Prompt entry**
  - You type a sentence or paragraph at the prompt line; the CLI colorizes it slightly (e.g., user input in green, system text in white/gray). [anthropic](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)
  - You can press `Ctrl+R` to search through your previous prompts and reuse or edit them, which is especially useful for iterating on the same task. [anthropic](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)

- **Agent thinking phase**
  - After you hit Enter, the CLI prints a status line like:
    - “Thinking… (reading 12 files)”
    - “Planning task: refactoring routes”
  - During this time the terminal is **blocked**; you can’t type new commands, but you can usually press `Ctrl+C` to interrupt the agent and drop back to a clean prompt. [blakecrosley](https://blakecrosley.com/en/guides/claude-code)

- **Tool execution phase**
  - When the agent decides to run a tool (read file, run `git`, execute a script), it:
    1. Prints a brief intent: “Editing src/auth/middleware.js”
    2. Shows the before/after diff or command output in a code‑block style box. [blakecrosley](https://blakecrosley.com/guides/claude-code)
  - The CLI then **waits for your explicit approval** (unless you’ve set a “no‑confirm” flag for automated runs).
  - You choose:
    - `y` / `Y`: apply and continue.
    - `n` / `N`: skip or stop this step.
    - `e` / `r`: edit the diff or regenerate the plan.
  - The UX is intentionally “guard‑rail’d”: nothing is silently written to disk without your consent in interactive mode. [blakecrosley](https://blakecrosley.com/guides/claude-code)

- **Git and file system feedback**
  - If git is configured, every significant change can be auto‑committed with a generated message; the CLI shows the commit SHA and summary. [blakecrosley](https://blakecrosley.com/en/guides/claude-code)
  - You can also ask for “Show me the last few commits” or “Undo the last commit” and get a confirmation before reverting.

---

### 4. Actual workflow and UX flow (step by step)

Here’s a typical real‑world workflow and how the UX unfolds:

1. **Start the session**
   - In your project dir:
     ```bash
     claude work
     ```
   - The CLI boots, prints its banner, and shows a short help primer: “Describe a task and I’ll plan, edit files, and run tests.” [anthropic](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)

2. **Describe a task**
   - You type:
     - “Add a new API endpoint for `/users/:id/export` that streams CSV data of the user’s activity.”
   - The CLI:
     - Acknowledges the task and prints a brief plan outline (e.g., “1. Add route, 2. create service, 3. write tests”). [blakecrosley](https://blakecrosley.com/guides/claude-code)

3. **Read and propose edits**
   - Agent:
     - Lists which route and controller files it will touch.
     - Shows a diff for the new route and controller logic.
   - You either:
     - Confirm → it writes the file and prints path.
     - Suggest tweaks (“rename this field”) → it edits the diff and shows it again. [anthropic](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)

4. **Run and fix tests**
   - You say: “Run tests and fix anything that breaks.”
   - CLI:
     - Runs `npm test` or equivalent.
     - Shows failing tests with snippets.
     - Proposes test fixes and updated implementation.
     - Waits for your approval before rewriting anything. [blakecrosley](https://blakecrosley.com/guides/claude-code)

5. **Review and commit**
   - You ask: “Summarize what you’ve changed” or “Show last commit”.
   - The CLI:
     - Prints a changelog‑style summary of files modified.
     - Optionally opens your editor on the diff or commit message for final tweaks. [blakecrosley](https://blakecrosley.com/en/guides/claude-code)

6. **Iterate and pivot**
   - You can then:
     - Ask follow‑ups (“Now add rate limiting to that endpoint”).
     - Ask it to “explore” alternative designs and then show trade‑offs.
   - The CLI maintains **context over the whole session**, so you don’t need to remind it of the codebase or recent changes. [anthropic](https://www.anthropic.com/news/enabling-claude-code-to-work-more-autonomously)

7. **Ending the session**
   - You type `quit` or `exit`, or just `Ctrl+C`‑`Ctrl+C` to terminate.
   - The CLI confirms shutdown and optionally prints a brief session summary (files touched, tools used, estimated tokens). [blakecrosley](https://blakecrosley.com/en/guides/claude-code)

---

### 5. UX for “power‑user” features

- **Remote execution & agents**
  - Teams can configure **subagents** or remote runners via the Claude Agent SDK; the CLI UX then looks like:
    - “Delegating to remote agent for long‑running tests…”
    - It shows streaming logs and lets you cancel or inspect the agent’s progress. [blakecrosley](https://blakecrosley.com/en/guides/claude-code)

- **Hooks and permissions**
  - The CLI supports `.claude` config files that define permission rules (which directories/files are read‑only, which can be edited, which commands are allowed). [blakecrosley](https://blakecrosley.com/en/guides/claude-code)
  - UX: when you try to ask it to edit a protected file, it prints: “This file is in a read‑only area; override via `--force`?”

- **History and search**
  - As mentioned, `Ctrl+R` opens a searchable prompt history, letting you:
    - Jump back to a refactoring pass,
    - or reuse a long‑form prompt you wrote earlier. [blakecrosley](https://blakecrosley.com/en/guides/claude-code)

---

### 6. UX strengths and constraints

- **Strengths**
  - Very close to how experienced devs already work: terminal + git + editor.
  - Clear boundaries: you authorize each write or command, avoiding “silent screw‑ups.” [blakecrosley](https://blakecrosley.com/guides/claude-code)

- **Constraints**
  - Everything is text‑only and keyboard‑driven; no mouse‑based file trees or inline syntax highlighting.
  - For richer visuals people wrap the CLI with web UIs (e.g., “Claude Code UI”), but the base UX stays purely terminal‑native. [youtube](https://www.youtube.com/watch?v=MflvJATVLeU)

If you’d like, in the next step I can map this into a **visual UX flow diagram** (as a MarkDown pseudo‑GUI) or a **terminal‑session transcript example** that shows exactly how prompts, diffs, and confirmations look line‑by‑line.
