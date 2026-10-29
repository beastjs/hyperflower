# WAT: Workflows, Agents, and Tools

WAT is a way to structure repeatable work that uses an AI agent. A workflow says
what outcome is needed and how to get there; the agent interprets the request and
coordinates the steps; tools perform operations that need consistent, verifiable
behavior.

Keep reasoning and execution separate where that improves reliability. The
separation is a design aid, not a requirement to turn every task into a workflow
or a script. A small, self-contained request can be handled directly. Use WAT
when a process recurs, has meaningful edge cases, or benefits from an explicit
record of its inputs, side effects, and completion criteria.

## How the layers fit together

| Layer | Owns | Should not own |
| --- | --- | --- |
| **Workflow** | The goal, required information, decision points, sequence, expected result, and recovery guidance | Credentials, hidden state, or implementation details that belong in code |
| **Agent** | Understanding the request, choosing and ordering steps, resolving ordinary ambiguity, and checking whether the result meets the goal | Reimplementing a reliable tool in prose or claiming an operation succeeded without evidence |
| **Tool** | A bounded operation with explicit inputs, validated data, observable outputs, and well-defined failures | Open-ended task interpretation or undocumented side effects |

The workflow guides the agent; the tool enforces the important runtime rules. A
workflow or prompt is not a security boundary. Validate untrusted data and enforce
permissions in the code that performs the operation.

## This repository

This is a Beast/TSRX application built with Bun and Vite. There is currently no
top-level `workflows/` or `tools/` directory. The WAT concepts apply to the
project, but the project should not be reshaped to match a generic folder
template.

Use the existing boundaries as the source of truth:

| Location | Responsibility |
| --- | --- |
| `src/App.btsx`, `src/components/` | Beast UI and browser-side interaction |
| `src/lib/` | Shared domain logic and provider integrations, including Effect services |
| `src/server/` | Server-side HTTP boundaries, request validation, and response handling |
| `src/trigger/`, `trigger.config.ts` | Trigger.dev background tasks and their configuration |
| `scripts/` | Deterministic project-maintenance and asset-generation scripts |
| `agent-patterns/` | Reusable instructions for coding agents, such as [Effect Schema patterns](../agent-patterns/effect-schema.md) |
| `docs/` | Architecture and maintenance documentation |

When adding a repeatable operator procedure, put the human-readable procedure in
a workflow document and keep executable behavior in the appropriate existing
module or script. Add a new directory only when there is a real workflow or tool
to put in it. Do not move application code into Python scripts to fit the WAT
model.

Follow the repository guidance in [`AGENTS.md`](../AGENTS.md) and the setup and
verification commands in [`README.md`](../README.md). In particular:

- Use the installed `effect` dependency for Effect code. Treat `repos/` as
  read-only reference material; do not import application code from it.
- Validate request, provider, and other external data at the boundary with the
  project’s Effect Schema patterns. Keep secrets server-side and use the
  established configuration patterns rather than embedding credentials.
- Before changing Trigger.dev tasks, schedules, realtime behavior, or chat
  agents, load the applicable skill from `.agents/skills/` as required by
  `AGENTS.md`.
- For application behavior changes, follow the README’s changelog convention.
  Use the project’s existing checks, such as `bun run check` and `bun test src`,
  when they are relevant to the change.

## Writing a workflow

Write workflows for repeatable processes, not as a record of every one-off task.
Keep steps specific enough to follow and short enough to maintain. State what is
known, what the agent may decide, and what must be confirmed before a side effect.

A useful workflow answers:

1. **Outcome:** What is the user trying to accomplish, and what counts as done?
2. **When to use:** Which requests belong here, and which do not?
3. **Inputs:** What values, files, accounts, or permissions are required? Which
   values can safely use a default?
4. **Procedure:** Which existing tools or project interfaces should be used, in
   what order, and what decisions does the agent make between them?
5. **Effects:** What data is read, written, sent, billed, or otherwise changed?
6. **Verification:** What observable evidence proves the expected result?
7. **Recovery:** What should happen on invalid input, partial completion, a
   retryable failure, or a failure that needs user input?

Use this outline when it makes the process clearer:

```md
# Workflow name

## Outcome
Describe the desired result and the completion condition.

## Use when
Describe matching requests and relevant exclusions.

## Inputs and prerequisites
List required values, safe defaults, access, and authorization.

## Procedure
1. Inspect the current state and reuse existing tools.
2. Validate inputs before performing side effects.
3. Run the required operation and capture its result.
4. Verify the completion condition.

## Failure handling
Explain safe retries, partial results, and when user input is required.

## Output
State what to return or where to save it.
```

Avoid copying long API references or code into a workflow. Link to the
implementation or maintained documentation instead, and update the workflow
when the supported procedure changes.

## Operating a workflow

1. **Clarify the outcome.** Identify the requested result, constraints, and any
   side effects. Preserve the user’s scope.
2. **Find the source of truth.** Read the relevant workflow, project instructions,
   implementation, and existing tool documentation before inventing a new path.
3. **Check prerequisites.** Confirm required inputs and access. Use documented
   defaults only when they are safe and unambiguous.
4. **Choose the right execution path.** Reuse an existing tool or application
   interface when it fits. Use direct inspection or a direct answer for work that
   does not need a reusable workflow or executable tool.
5. **Run bounded steps.** Keep the agent’s decisions explicit and send exact,
   validated inputs to tools. Do not silently widen the requested scope.
6. **Verify the result.** Inspect returned values or resulting state against the
   workflow’s completion condition. A successful tool invocation is not always
   proof that the user’s goal is complete.
7. **Report accurately.** Summarize what changed, where the result is, and any
   remaining limitation. Distinguish verified facts from assumptions.

If a step fails, read the full diagnostic and identify whether the failure is
from invalid input, missing configuration, an external service, or the tool
itself. Retry only when the operation is safe to repeat or has an idempotency
guard. Before repeating an operation that could duplicate an external change or
incur a charge, follow the authorization and cost constraints already given for
the task. Preserve useful error details when reporting or updating the workflow.

## Designing tools

Tools should make important behavior predictable and reviewable:

- Give each tool one clear responsibility and a narrow, explicit input and output
  contract.
- Validate data where it crosses a boundary. In this project, use Effect Schema
  and typed Effect errors for Effect-based boundaries; see
  [`agent-patterns/effect-schema.md`](../agent-patterns/effect-schema.md).
- Keep side effects visible. Document files, services, records, or accounts the
  tool may change, and return enough information to verify what happened.
- Make retries safe where practical. Use idempotency for operations that may be
  retried after timeouts or interrupted responses.
- Fail clearly. Preserve useful upstream context without leaking secrets or
  returning internal credentials to the browser.
- Keep secrets in the established server-side configuration. Never put secret
  values in source, prompts, logs, workflow examples, or generated artifacts.
- Avoid hidden prerequisites such as an assumed working directory, a manually
  edited file, or an undocumented environment variable.
- Prefer the existing project dependency and integration over a parallel
  implementation. Keep one authoritative place for each behavior.
- For destructive or broad operations, make the target and scope explicit and
  provide a preview or dry-run when practical.

For example, `src/server/api.ts` validates incoming generation requests and
keeps provider credentials on the server. Some generation requests run inline;
others start Trigger.dev tasks and return a run ID. That boundary lets callers
receive a defined result without knowing provider secrets or duplicating
provider-specific execution logic.

## Example: generation request

This example maps the existing generation flow to WAT responsibilities; it does
not imply that every request needs a separate workflow document or an AI agent.

- **Workflow:** Define the required prompt and settings, expected output, and
  how to handle invalid settings or a failed generation.
- **Agent or caller:** Gather the requested values, make only supported choices,
  and submit the request through the existing application boundary.
- **Tool:** The server decodes the request against its schema, dispatches the
  provider operation or background task, and returns a result or run ID.
- **Verification:** Check the returned result or run status before describing
  generation as complete. Surface a failure as a failure, with its useful
  message.

The current request schema and dispatch behavior live in
[`src/server/api.ts`](../src/server/api.ts); provider implementations and shared
types live under `src/lib/`, and background tasks live under `src/trigger/`.

## Avoid

- Requiring a workflow, agent, or new script for every task.
- Treating direct use of an appropriate integration or a straightforward answer
  as a failure of the WAT model.
- Assuming this TypeScript application has generic Python tools, cloud-delivery
  requirements, or a pre-existing workflow directory.
- Putting business decisions, retry policy, or credential handling only in
  natural-language instructions when code must enforce them.
- Duplicating existing provider, API, or task logic in a new tool.
- Making up missing inputs or reporting success based only on intent or an
  accepted request.
- Retrying a non-idempotent or billable operation without checking whether the
  retry is safe and authorized.
- Copying secrets, sensitive payloads, or unnecessary personal data into logs,
  workflow files, or final reports.
- Keeping stale instructions after a tool, API contract, or supported process
  changes.
