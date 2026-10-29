# WAT Framework — Project Template

> **Adapt this file before relying on its project-specific guidance.** Inspect the
> repository, replace every `{{...}}` placeholder with verified information, and
> remove sections that do not apply. Do not guess paths, commands, permissions,
> integrations, or project conventions. Keep the general WAT principles intact.

## 1. Project profile

- **Project:** `{{PROJECT_NAME}}`
- **Purpose:** `{{ONE_SENTENCE_PROJECT_PURPOSE}}`
- **Primary languages and frameworks:** `{{LANGUAGES_AND_FRAMEWORKS}}`
- **Authoritative project instructions:** `{{INSTRUCTION_FILES_AND_PATHS}}`
- **Main setup and verification documentation:** `{{README_OR_DOC_PATHS}}`
- **Workflow documents live at:** `{{WORKFLOW_DIRECTORY_OR_NONE}}`
- **Executable tools live at:** `{{TOOL_LOCATIONS_OR_NONE}}`

These values must describe the repository as it exists. If the project has no
dedicated workflow or tool directory, say so and name the existing modules,
commands, or integrations that fill those roles. WAT is a way to clarify
responsibilities; it does not require a particular folder layout.

## 2. The WAT model

WAT stands for **Workflows, Agents, and Tools**:

- **Workflow:** Documents a repeatable process: its outcome, inputs, decision
  points, execution order, expected result, and recovery guidance.
- **Agent:** Understands the user’s request, selects and coordinates the needed
  steps, makes bounded decisions, and checks whether the result meets the goal.
- **Tool:** Performs a defined operation with explicit inputs, observable
  outputs, and predictable failure behavior.

Keep reasoning separate from execution when that makes the process easier to
verify. Not every task needs all three layers. Handle simple requests directly;
use a workflow when a process recurs or has enough constraints and edge cases to
benefit from written guidance; use a tool when an operation needs repeatable,
testable execution.

Workflows help agents choose the right actions, but they are not security
boundaries. Enforce permissions, validate untrusted input, and protect sensitive
data in the code or integration that performs the operation.

## 3. Repository map

Replace this table with the project’s real boundaries. Prefer a short list of
authoritative locations over an exhaustive directory dump.

| Location or interface | Responsibility | Source to consult |
| --- | --- | --- |
| `{{APPLICATION_ENTRY_POINT}}` | `{{RESPONSIBILITY}}` | `{{SOURCE_FILE_OR_DOC}}` |
| `{{DOMAIN_OR_SERVICE_LAYER}}` | `{{RESPONSIBILITY}}` | `{{SOURCE_FILE_OR_DOC}}` |
| `{{API_OR_EXTERNAL_BOUNDARY}}` | `{{RESPONSIBILITY}}` | `{{SOURCE_FILE_OR_DOC}}` |
| `{{BACKGROUND_OR_AUTOMATION_LAYER}}` | `{{RESPONSIBILITY_OR_NONE}}` | `{{SOURCE_FILE_OR_DOC_OR_NONE}}` |
| `{{SCRIPTS_OR_OPERATIONS_LOCATION}}` | `{{RESPONSIBILITY_OR_NONE}}` | `{{SOURCE_FILE_OR_DOC_OR_NONE}}` |

### Project conventions to record

Fill in only conventions verified from the repository or its authoritative
documentation. Link to existing guidance when the details are lengthy.

- **Dependency and package manager:** `{{PACKAGE_MANAGER_AND_DEPENDENCY_RULES}}`
- **Validation and data schemas:** `{{VALIDATION_PATTERN_OR_NONE}}`
- **Errors and logging:** `{{ERROR_AND_LOGGING_CONVENTIONS}}`
- **Secrets and configuration:** `{{SECRET_STORAGE_AND_CONFIGURATION_RULES}}`
- **External services and side effects:** `{{SERVICE_BOUNDARIES_AND_COST_OR_APPROVAL_RULES}}`
- **Tests and verification commands:** `{{RELEVANT_COMMANDS_AND_WHEN_TO_USE_THEM}}`
- **Change documentation or release notes:** `{{CHANGELOG_OR_RELEASE_CONVENTION_OR_NONE}}`
- **Specialized agent skills or contributor guides:** `{{SKILLS_AND_PATHS_OR_NONE}}`

Never include actual secret values. Record the supported secret source and the
names of configuration keys only when appropriate.

## 4. How an agent should work

For each request:

1. **Understand the outcome.** Identify the requested result, constraints,
   destination, and what evidence will count as completion.
2. **Inspect the source of truth.** Read applicable repository instructions,
   existing workflows, relevant implementation, and tool documentation before
   choosing an approach.
3. **Reuse existing paths.** Prefer the project’s established APIs, commands,
   modules, and integrations. Do not create a parallel tool when an existing one
   already provides the needed behavior.
4. **Check inputs and authority.** Validate required inputs and respect the
   authorization, privacy, cost, and side-effect constraints supplied by the
   user and project instructions. Do not ask again for permission already given.
5. **Choose the smallest suitable process.** Use a workflow and tool when they
   add repeatability or safety. Do not force a simple task through unnecessary
   layers.
6. **Execute bounded steps.** Make decisions explicit, pass validated inputs to
   tools, and do not silently expand the requested scope.
7. **Verify the outcome.** Check returned data or resulting state against the
   completion condition. An accepted request or successful command is not always
   proof that the overall goal is complete.
8. **Report accurately.** State what was done, where the result is, and any
   remaining limitation. Separate verified facts from assumptions.

When information is missing, first check the repository and available tool
outputs. Resolve routine choices from established conventions. Ask the user only
when the missing information changes the requested outcome, authorization, or a
materially consequential choice.

### Failure and retry behavior

- Read the full diagnostic and identify whether the failure is caused by input,
  configuration, permissions, an external dependency, or the tool itself.
- Preserve useful error context. Do not hide a failure behind a success-shaped
  response.
- Retry only when repeating the operation is safe or an idempotency mechanism
  prevents duplicate effects.
- Before retrying an operation that may incur a cost or duplicate an external
  change, follow the authorization and retry policy recorded above.
- If an operation partially completed, inspect its current state before deciding
  whether to resume, compensate, or report the partial result.

## 5. Writing workflow documents

Create a workflow when the process is repeatable and documenting it will reduce
ambiguity, errors, or unnecessary rediscovery. A workflow should describe the
user-facing goal and the agent’s choices, while pointing to code for rules that
must be enforced at runtime.

Every workflow should make these points clear:

- Which requests it applies to and which it does not.
- The required inputs, their source, validation rules, and safe defaults.
- Prerequisites, permissions, and consequential side effects.
- The steps and decision points, including which existing tool to call.
- The expected output, destination, and observable completion condition.
- Failure handling, safe retries, and conditions that require user input.

Use the following as a starting point and remove headings that do not help the
specific process:

```md
# {{WORKFLOW_NAME}}

## Outcome
{{DESIRED_RESULT_AND_COMPLETION_CONDITION}}

## Use when
{{MATCHING_REQUESTS_AND_EXCLUSIONS}}

## Inputs and prerequisites
| Input | Required? | Source or default | Validation |
| --- | --- | --- | --- |
| {{INPUT_NAME}} | {{YES_OR_NO}} | {{SOURCE_OR_SAFE_DEFAULT}} | {{RULE}} |

{{ACCESS_OR_PERMISSION_REQUIREMENTS}}

## Effects and data handling
{{WHAT_IS_READ_WRITTEN_SENT_BILLED_OR_CHANGED}}

## Procedure
1. {{INSPECT_OR_PREPARE}}
2. {{VALIDATE_INPUTS}}
3. {{CALL_EXISTING_TOOL_WITH_EXPLICIT_INPUTS}}
4. {{VERIFY_COMPLETION_CONDITION}}

## Failure handling
{{SAFE_RETRIES_PARTIAL_RESULTS_AND_ESCALATION_CONDITIONS}}

## Output
{{WHAT_TO_RETURN_OR_WHERE_TO_SAVE_IT}}
```

Keep workflows concise. Link to maintained implementation or API documentation
instead of copying large code samples or duplicating tool behavior. Update a
workflow when its supported process changes; remove obsolete steps and references.

## 6. Designing and maintaining tools

Use the project’s established language, runtime, dependency, and module
conventions. A useful tool has:

- **One clear responsibility** and an explicit input/output contract.
- **Boundary validation** for user input, external responses, files, and other
  untrusted data.
- **Visible effects:** a clear description of what it can read, write, send,
  delete, or charge for.
- **Predictable failures:** actionable errors that retain useful context without
  leaking credentials or sensitive payloads.
- **Safe retry behavior:** idempotency or an explicit warning when a retry can
  duplicate effects.
- **Observable results:** enough returned information to verify the operation.
- **Explicit configuration:** no hidden working-directory, local-file, account,
  or environment assumptions.
- **Appropriate access controls:** enforce authorization where the operation is
  performed, not only in workflow prose.

Prefer the project’s existing integration and dependencies. Make destructive or
broad operations explicit about their target and scope; provide a preview or
dry-run when practical. Keep credentials out of source, prompts, workflow
examples, logs, generated artifacts, and user-visible responses.

### Tool inventory

Maintain this inventory only if it helps agents discover the existing tools.
Document invocation details in the tool’s own help or reference when possible.

| Tool or interface | Purpose | Inputs | Effects | Result or verification |
| --- | --- | --- | --- | --- |
| `{{TOOL_NAME_OR_COMMAND}}` | `{{PURPOSE}}` | `{{INPUTS}}` | `{{EFFECTS}}` | `{{RESULT}}` |

## 7. Project adaptation checklist

Before treating this template as active project guidance, the adapting agent
should:

- Read the repository’s agent instructions, README, package/build manifests,
  and relevant contributor documentation.
- Inspect the directory structure and the implementation around important data
  and side-effect boundaries.
- Confirm actual workflow, tool, script, test, and release locations. Do not
  create new directories just to match this template.
- Verify each command against the project’s scripts or documentation. Do not
  claim a command was run unless it was actually run.
- Record real validation, error, logging, secret, and authorization practices.
- Replace every `{{...}}` placeholder with verified facts or remove the entry
  when it does not apply.
- Link to authoritative files using paths that resolve from this document.
- Keep project-specific behavior out of the generic WAT definitions; put those
  details in the profile, repository map, workflow documents, or linked guides.
- Review the adapted document for stale, conflicting, or overly broad rules.

If a detail cannot be verified, mark it as unknown and ask the project owner only
when the missing detail blocks safe or correct work. Never turn a guess into a
project rule.
