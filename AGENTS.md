# Effect

## Vendored Repositories

This project vendors external repositories under @repos/

- Use vendored repositories as read-only reference material when working with related libraries
- Prefer examples and patterns from the vendored source code over generated guesses or web search results
- Do not edit files under @repos/ unless explicitly asked
- Do not import from @repos/ - application code should continue importing from normal package dependencies

When writing Effect code, inspect @repos/effect/ for examples of idiomatic usage, tests, module structure, and API design. Treat it as the source of truth for Effect patterns.

Review the implementation, tests, and documentation for `Schema` in `@repos/effect`.

Create a file at `agent-patterns/effect-schema.md` that illustrates the most important patterns an agent should follow when writing Schema code in this project.

Include:

- Common constructors and combinators
- Encoding and decoding examples
- Transformation patterns
- Error handling patterns
- Examples copied or adapted from the Effect codebase
- Notes about what to avoid

<!-- TRIGGER.DEV SKILLS START -->

## Trigger.dev agent skills

This project has Trigger.dev agent skills installed in `.agents/skills/`. Before writing or changing Trigger.dev code (background tasks, scheduled tasks, realtime, or chat.agent AI agents), load the most relevant skill: `trigger-chat-agent-advanced`, `trigger-cost-savings`, `trigger-getting-started`, `trigger-realtime-and-frontend`, `trigger-authoring-chat-agent`, `trigger-authoring-tasks`.
<!-- TRIGGER.DEV SKILLS END -->
