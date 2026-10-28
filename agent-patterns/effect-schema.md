# Effect Schema patterns for agents

How to write `Schema` code in Hyperflower. Everything here is checked against the
vendored Effect source at `repos/effect/` (package `effect@4.0.7`, which matches the
app's `"effect": "^4.0.7"` dependency).

- The vendored source can be slightly ahead of the published package: for example,
  `Schema.UnknownFromJsonString` exists in `repos/effect/` but not in the installed
  `effect@4.0.7`. `bun run typecheck` is the final check; use
  `Schema.fromJsonString(Schema.Unknown)` instead.
- Treat `repos/effect/` as **read-only reference**. Never import from it. App code
  imports from the package: `import { Schema } from "effect"`.
- Main sources (all paths relative to `repos/effect/`):
  - `packages/effect/SCHEMA.md`: the full guide (7.5k lines, so read it in chunks)
  - `packages/effect/src/Schema.ts`: schemas, combinators, decode/encode APIs
  - `packages/effect/src/SchemaTransformation.ts`, `SchemaGetter.ts`, `SchemaIssue.ts`, `SchemaParser.ts`
  - `packages/effect/test/schema/Schema.test.ts`: behaviour specs
  - `ai-docs/src/01_effect/02_schema/10_schema-basics.ts`: the canonical "how to use it" example
  - `migration/schema.md`: v3 → v4 renames (helps you spot outdated patterns)

> **This is Effect v4 Schema.** Most blog posts, Stack Overflow answers and LLM
> training data describe v3 (`@effect/schema`, `Schema.transform(a, b, ...)`,
> `Schema.Union(A, B)`, `ParseResult`, and so on). Those APIs no longer exist or
> have different meanings. If you're unsure, grep `packages/effect/src/Schema.ts`
> for `^export (const|function|class) <Name>` before using a name.

---

## 0. Imports

Everything is exported from the `effect` root:

```ts
import {
  Effect, Option, Result, Schema, SchemaGetter, SchemaIssue, SchemaParser, SchemaTransformation, Struct
} from "effect"
```

`Struct` here is Effect's `Struct` module (`pick`, `omit`, `map`, `assign`), not
`Schema.Struct`. Importing `Number` from `"effect"` (as in section 5.3) shadows the
global `Number`.

`effect/schema` is a subpath, but it only exports `Model`, `VariantSchema` and the
compilers (`packages/effect/src/schema/index.ts`). It does **not** export
`Getter`/`Parser`, even though one stale snippet in `SCHEMA.md` (around line 224)
imports them from there. Use `SchemaGetter` / `SchemaParser` from `"effect"`.

---

## 1. Model types: `Type`, `Encoded`, services

Every schema is a `Codec<Type, Encoded, DecodingServices, EncodingServices>`.

- **decode**: `Encoded` (wire / storage shape) → `Type` (domain value)
- **encode**: `Type` → `Encoded`

```ts
// ai-docs/src/01_effect/02_schema/10_schema-basics.ts
export class User extends Schema.Class<User>("path/to/module/User")({
  id: Schema.Int,
  name: Schema.NonEmptyString,
  email: Schema.String,
  role: Schema.Literals(["admin", "member"])
}) {}

export type UserType = typeof User["Type"]
export type UserEncoded = typeof User["Encoded"]
```

Derive TypeScript types from schemas (`typeof X.Type`, `typeof X.Encoded`).
Don't hand-write a parallel `interface` unless you need one for recursion
(see section 3.6).

---

## 2. Elementary constructors

Source: `SCHEMA.md` §"Defining Elementary Schemas" (lines ~200–487).

```ts
// Primitives
Schema.String; Schema.Number; Schema.BigInt; Schema.Boolean
Schema.Symbol; Schema.Undefined; Schema.Null; Schema.Void
Schema.Unknown; Schema.Never

// Ready-made refinements
Schema.NonEmptyString
Schema.Finite        // excludes NaN / ±Infinity
Schema.Int

// Literals (note: Literals takes an ARRAY)
Schema.Literal("tuna")
Schema.Literals(["red", "green", "blue"])   // .literals, .members, .pick([...])

// Instances / built-in data types
Schema.Date          // a valid Date *object* (rejects new Date(NaN))
Schema.URL           // a URL instance
Schema.instanceOf(MyClass)
```

### Checks (filters): `.check(...)` with `is*` factories

```ts
// SCHEMA.md §Strings / §Numbers / §Integers
Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(5))
Schema.String.check(Schema.isPattern(/^[a-z]+$/))
Schema.String.check(Schema.isUUID())
Schema.String.check(Schema.isTrimmed())
Schema.Number.check(Schema.isBetween({ minimum: 5, maximum: 10 }))
Schema.Number.check(Schema.isGreaterThan(0))
Schema.Number.check(Schema.isInt())
```

All filters have an `is` prefix in v4. `positive`/`nonNegative` etc. were removed, so
use `isGreaterThan(0)` / `isGreaterThanOrEqualTo(0)` (`migration/schema.md` §Filter renames).

### Template literals

```ts
// SCHEMA.md §Template literals
const email = Schema.TemplateLiteral([
  Schema.String.check(Schema.isMinLength(1)),
  "@",
  Schema.String.check(Schema.isMaxLength(64))
])
// Type: `${string}@${string}`
```

---

## 3. Composite constructors and combinators

### 3.1 Structs and optionality

```ts
// SCHEMA.md §Optional Fields (line ~525)
export const schema = Schema.Struct({
  a: Schema.optionalKey(Schema.FiniteFromString),                 // a?: number
  b: Schema.optional(Schema.FiniteFromString),                    // b?: number | undefined
  c: Schema.optionalKey(Schema.NullOr(Schema.FiniteFromString)),  // c?: number | null
  d: Schema.optional(Schema.NullOr(Schema.FiniteFromString))      // d?: number | null | undefined
})
```

- `optionalKey` means the key may be absent (exact optional).
- `optional` means the key may be absent **or** `undefined`.
- `NullOr`, `UndefinedOr` and `NullishOr` widen the value, not the key.
- `mutableKey` removes `readonly`.

### 3.2 Reuse and derive struct fields

```ts
// SCHEMA.md §Reusing Fields / §Deriving Structs
const Timestamped = Schema.Struct({ createdAt: Schema.Date, updatedAt: Schema.Date })

const Post = Schema.Struct({
  ...Timestamped.fields,
  title: Schema.String
})

Schema.Struct({ a: Schema.String, b: Schema.Number }).mapFields(Struct.pick(["a"]))
Schema.Struct({ a: Schema.String, b: Schema.Number }).mapFields(Struct.omit(["b"]))

// v3 `partial` → map every field through optional (migration/schema.md summary table)
Post.mapFields(Struct.map(Schema.optional))
```

### 3.3 Arrays, tuples and records

```ts
Schema.Array(Schema.String)
Schema.NonEmptyArray(Schema.String)
Schema.Tuple([Schema.String, Schema.Finite])    // ARRAY argument
Schema.Record(Schema.String, Schema.Number)     // positional (key, value), not { key, value }
```

Dynamic `Record` values can't use `optionalKey`/`optional`. Use `UndefinedOr` instead
(`SCHEMA.md` §Records).

### 3.4 Unions and tagged unions

```ts
Schema.Union([Schema.NonEmptyString, Schema.Number])   // ARRAY argument; first match wins

// SCHEMA.md §Tagged Unions
const Shape = Schema.TaggedUnion({
  A: { a: Schema.String },
  B: { b: Schema.Finite }
})
// equivalent to Schema.Union([Schema.TaggedStruct("A", {...}), Schema.TaggedStruct("B", {...})])
```

When the discriminant is not `_tag` (common in external APIs), add helpers with
`toTaggedUnion`:

```ts
// SCHEMA.md §Augmenting Tagged Unions
const tagged = Schema.Union([
  Schema.Struct({ type: Schema.tag("A"), a: Schema.String }),
  Schema.Struct({ type: Schema.tag("B"), b: Schema.Finite })
]).pipe(Schema.toTaggedUnion("type"))

tagged.cases.A                       // member schema
tagged.guards.A(value)               // type guard, accepts unknown
tagged.isAnyOf(["A", "B"])(member)   // narrows an already-typed union member
const describe = tagged.match({
  A: (a) => `A: ${a.a}`,
  B: (b) => `B: ${b.b}`
})
```

### 3.5 Brands and refinements

```ts
// SCHEMA.md §Branding / §Refinements
const UserId = Schema.String.pipe(Schema.brand("UserId"))   // type-only, no runtime check

const AtLeastTwo = Schema.Array(Schema.String).pipe(
  Schema.refine((arr): arr is readonly [string, string, ...Array<string>] => arr.length >= 2)
)
```

Brands add **no runtime validation**. Pair them with a `.check(...)` when the brand
should mean something, for example `Schema.String.check(Schema.isUUID()).pipe(Schema.brand("JobId"))`.

### 3.6 Recursive schemas

```ts
// SCHEMA.md §Recursive Schemas (line ~2251)
interface Category {
  readonly name: string
  readonly children: ReadonlyArray<Category>
}

const Category: Schema.Codec<Category> = Schema.Struct({
  name: Schema.String,
  children: Schema.Array(Schema.suspend((): Schema.Codec<Category> => Category))
})
```

If `Encoded` differs from `Type`, annotate both: `Schema.Codec<Category, CategoryEncoded>`.

### 3.7 Classes, opaque structs and errors

```ts
// SCHEMA.md §Class API / §TaggedClass / §TaggedError
class Person extends Schema.Class<Person>("Person")({ name: Schema.String }) {
  get greeting() { return `hi ${this.name}` }    // methods and getters are allowed
}

class Cat extends Schema.TaggedClass<Cat>()("Cat", { lives: Schema.Number }) {}
class Dog extends Schema.TaggedClass<Dog>()("Dog", { wagsTail: Schema.Boolean }) {}
const Animal = Schema.Union([Cat, Dog])

class HttpError extends Schema.TaggedError<HttpError>()("HttpError", {
  status: Schema.Number,
  message: Schema.String
}) {}
```

- `new Person({...})` and `Person.make({...})` **validate** and throw on bad input.
  `Person.makeOption(...)` returns an `Option` instead.
- To subclass, use `Base.extend<Child>("Child")({ ...newFields })`. A plain
  `class Child extends Base` isn't supported (`SCHEMA.md` §extend).
- For a cross-field check on a class, pass a `Struct` with `.check(...)` instead
  of a field record (`SCHEMA.md` §Classes › Filters).
- `Schema.Opaque<Self>()(Schema.Struct({...}))` gives a distinct nominal type with
  plain-object runtime values and no methods. Use it when you don't need a prototype.

---

## 4. Decoding and encoding

Source: `packages/effect/src/Schema.ts` lines ~1461–2400 and `SchemaParser.ts`.

Each API has an `Unknown` variant (input typed `unknown`) and a typed variant (input
typed `Encoded`). Pick the result shape that fits the call site:

| You are… | Decode | Encode | Failure |
| --- | --- | --- | --- |
| inside `Effect` code (preferred) | `decodeUnknownEffect` / `decodeEffect` | `encodeUnknownEffect` / `encodeEffect` | `SchemaError` in the error channel |
| at a sync boundary that may throw | `decodeUnknownSync` / `decodeSync` | `encodeUnknownSync` / `encodeSync` | throws `SchemaError` |
| needing a value, not an exception | `decodeUnknownExit`, `decodeUnknownResult`, `decodeUnknownOption` | `encodeUnknownExit`, … | `Exit`/`Result` with `SchemaError`, or `None` |
| in Promise-land | `decodeUnknownPromise` | `encodeUnknownPromise` | rejected promise |
| only needing a guard | `Schema.is(schema)` / `Schema.asserts(schema, input)` | | `boolean` / throws |

Sync, `Exit`, `Result` and `Option` variants only accept schemas with **no** decoding
services. Use the `Effect` variants when a schema needs services.

### Build parsers once and reuse them

```ts
// ai-docs/src/01_effect/02_schema/10_schema-basics.ts
export const decodeUser = Schema.decodeUnknownEffect(User)
export const encodeUser = Schema.encodeEffect(User)
```

### Decode JSON text in one step

```ts
// SCHEMA.md §fromJsonString (line ~4694)
const Payload = Schema.Struct({ a: Schema.Number })
Schema.decodeUnknownSync(Schema.fromJsonString(Payload))(`{"a":1,"b":2}`)
// => { a: 1 }   (excess keys are stripped by default)
```

Use `fromJsonString` instead of `JSON.parse` followed by decode. Malformed JSON then
becomes a `SchemaError` too, rather than a thrown `SyntaxError`.

### Parse options

`ParseOptions` (`packages/effect/src/SchemaAST.ts` ~line 507) can be passed when
creating the parser or when calling it. Options passed at call time win.

```ts
Schema.decodeUnknownExit(schema)(input, {
  errors: "all",               // collect every issue (default "first")
  onExcessProperty: "error"    // reject unknown keys (default "ignore" = strip)
})
```

Use `onExcessProperty: "error"` for strict request bodies. Keep the default
`"ignore"` for third-party API responses, which often gain new fields.

### Renaming wire keys (snake_case APIs)

```ts
// SCHEMA.md §Renaming Encoded Keys (line ~1122); tested in test/schema/Schema.test.ts "encodeKeys"
const schema = Schema.Struct({
  userId: Schema.FiniteFromString,
  accountName: Schema.String
}).pipe(Schema.encodeKeys({ userId: "user_id", accountName: "account_name" }))

Schema.decodeUnknownSync(schema)({ user_id: "1", account_name: "alice" })
// { userId: 1, accountName: "alice" }
Schema.encodeUnknownSync(schema)({ userId: 1, accountName: "alice" })
// { user_id: "1", account_name: "alice" }
```

This is the right tool for provider payloads such as Ark, Workers AI or Trigger.dev
task I/O that use snake_case. Apply `encodeKeys` **after** the full struct is
assembled.

### Constructors (`make`) vs decoding

`schema.make(value)` validates a value that is **already of `Type`** and applies
constructor defaults. It doesn't run decoding transformations.
`schema.makeOption(value)` is the non-throwing variant (`SCHEMA.md` §Constructors).

```ts
// SCHEMA.md §Default Values in Constructors
const schema = Schema.Struct({
  a: Schema.Number.pipe(Schema.withConstructorDefault(Effect.succeed(-1)))
})
schema.make({})   // { a: -1 }
```

---

## 5. Transformation patterns

Source: `SCHEMA.md` §Transformations (lines ~3202–3660),
`packages/effect/src/SchemaTransformation.ts`, `packages/effect/src/SchemaGetter.ts`.

Transformations are **standalone values** (`Transformation<T, E, RD, RE>`), each made
of two `Getter`s (`decode`, `encode`). Attach them with:

- `Schema.decodeTo(target, transformation?)`: source schema → a *different* target
  schema. Its inverse is `Schema.encodeTo`.
- `Schema.decode(transformation)`: same schema on both sides (for example trimming).
  Its inverse is `Schema.encode`.

### 5.1 Prefer built-in codecs

Check `Schema.ts` before writing your own:
`FiniteFromString`, `NumberFromString`, `BigIntFromString`, `DateFromString`,
`DateFromMillis`, `URLFromString`, `BooleanFromBit`, `Trim`, `OptionFromNullOr`,
`OptionFromOptionalKey`, `OptionFromUndefinedOr`, `RedactedFromValue`,
`StringFromBase64`, `Uint8ArrayFromBase64`, `DurationFromMillis`, `fromJsonString`, …

```ts
Schema.decodeUnknownSync(Schema.NumberFromString)("42")   // 42 (Schema.ts JSDoc)

// null on the wire → Option in the domain (Schema.ts ~line 16153)
const Nickname = Schema.OptionFromNullOr(Schema.String)
```

### 5.2 Pure, infallible transforms: `SchemaTransformation.transform`

```ts
// SCHEMA.md §Defining an Inline Transformation
const Kilometers = Schema.Finite.pipe(
  Schema.decode(
    SchemaTransformation.transform({
      decode: (meters) => meters / 1000,
      encode: (kilometers) => kilometers * 1000
    })
  )
)

// SCHEMA.md §decodeTo
const NumberFromString = Schema.String.pipe(
  Schema.decodeTo(Schema.Number, SchemaTransformation.numberFromString)
)
```

### 5.3 Fallible transforms: `SchemaTransformation.transformEffect`

Fail with a `SchemaIssue`, never with a thrown `Error`. Pass `input` and `options`
to the issue so `{ reportInput: true }` is respected.

```ts
// SCHEMA.md §Defining an Inline Transformation (URL example)
const URLFromString = Schema.String.pipe(
  Schema.decodeTo(
    Schema.instanceOf(URL),
    SchemaTransformation.transformEffect({
      decode: (s, options) =>
        Effect.try({
          try: () => new URL(s),
          catch: () => new SchemaIssue.InvalidValue({ message: "Invalid URL string" }, s, options)
        }),
      encode: (url) => Effect.succeed(url.href)
    })
  )
)
```

The same thing at getter level (`migration/schema.md` §transformOrFail). This is the
v4 replacement for v3 `transformOrFail`:

```ts
import { Number } from "effect"

const NumberFromString = Schema.String.pipe(
  Schema.decodeTo(Schema.Number, {
    decode: SchemaGetter.transformEffect((s) =>
      Option.match(Number.parse(s), {
        onNone: () => Effect.fail(new SchemaIssue.InvalidValue()),
        onSome: Effect.succeed
      })
    ),
    encode: SchemaGetter.String()
  })
)
```

### 5.4 Compose transformations and schemas

```ts
// SCHEMA.md §Composing Transformations
const trimToLowerCase = SchemaTransformation.composeTransformation(
  SchemaTransformation.trim(),
  SchemaTransformation.toLowerCase()
)
const Normalized = Schema.String.pipe(Schema.decode(trimToLowerCase))
Schema.decodeUnknownSync(Normalized)("  Abc")   // "abc"

// SCHEMA.md §Schema composition: chain schemas whose types line up
const MilesFromMeters = KilometersFromMeters.pipe(Schema.decodeTo(MilesFromKilometers))
```

When the types only partly line up, use `SchemaTransformation.passthrough()`,
`passthroughSubtype()` or `passthroughSupertype()` (`SCHEMA.md` §Passthrough Helpers).

### 5.5 Defaults while decoding

```ts
// SCHEMA.md §Decoding Defaults (line ~623)
const schema = Schema.Struct({
  // default given as an Encoded value ("1" is a string, then decoded to 1)
  a: Schema.FiniteFromString.pipe(Schema.withDecodingDefault(Effect.succeed("1"))),
  // default given as a Type value (skips decoding)
  b: Schema.FiniteFromString.pipe(Schema.withDecodingDefaultType(Effect.succeed(1)))
})
Schema.decodeUnknownSync(schema)({})   // { a: 1, b: 1 }
```

| API | Encoded side accepts | Default is a… |
| --- | --- | --- |
| `withDecodingDefaultKey` | key absent | `Encoded` value |
| `withDecodingDefault` | key absent or `undefined` | `Encoded` value |
| `withDecodingDefaultTypeKey` | key absent | `Type` value |
| `withDecodingDefaultType` | key absent or `undefined` | `Type` value |

Decoding defaults (applied to wire data) and constructor defaults
(`withConstructorDefault`, applied in `make`) are separate. Add both if you need both.

### 5.6 Optional-key transforms and omitting on encode

```ts
// SCHEMA.md §Managing Optional Keys: "" or missing → None
const OptionFromNonEmptyString = Schema.optionalKey(Schema.String).pipe(
  Schema.decodeTo(
    Schema.Option(Schema.NonEmptyString),
    SchemaTransformation.transformOptional({
      decode: (oe) =>
        Option.isSome(oe) && oe.value !== "" ? Option.some(Option.some(oe.value)) : Option.some(Option.none()),
      encode: (ot) => Option.flatten(ot)
    })
  )
)

// SCHEMA.md §Omitting a Key During Encoding
const WithTag = Schema.Struct({
  _tag: Schema.tagDefaultOmit("MyTag"),   // filled in on decode, dropped on encode
  a: Schema.FiniteFromString
})
```

### 5.7 Effectful validation (needs I/O or services)

`.check(...)` filters must be **synchronous**. For async checks, use
`SchemaGetter.checkEffect` inside a transformation (`SCHEMA.md` §Effectful Filters):

```ts
const schema = Schema.Finite.pipe(
  Schema.decode({
    decode: SchemaGetter.checkEffect((n, options) =>
      Effect.gen(function*() {
        const user = yield* Effect.result(myapi(n))
        return Result.isFailure(user)
          ? new SchemaIssue.InvalidValue({ message: "not found" }, n, options)
          : undefined
      })
    ),
    encode: SchemaGetter.passthrough()
  })
)
```

### 5.8 Flipping

`Schema.flip(schema)` swaps the decode and encode directions. Reuse it instead of writing
the inverse codec by hand (`SCHEMA.md` §Flipping Schemas).

---

## 6. Validation patterns

Source: `SCHEMA.md` §Validation (lines ~2539–2975).

```ts
// Custom filter. Return true/undefined for ok, false for a generic failure,
// or a string for a failure with that message.
const schema = Schema.String.check(
  Schema.makeFilter((s) => s.length >= 3 || `length must be >= 3, got ${s.length}`, {
    title: "length >= 3",
    description: "a string with at least 3 characters"
  })
)

// Cross-field check that reports the issue at a nested path
const Passwords = Schema.Struct({ password: Schema.String, confirmPassword: Schema.String }).check(
  Schema.makeFilter((o) =>
    o.password === o.confirmPassword
      ? undefined
      : { path: ["password"], issue: "password and confirmPassword must match" }
  )
)

// Several issues at once: return Array<Schema.FilterIssue>
// Short-circuit: Schema.isMinLength(3).abort()
// Reusable bundle: Schema.makeFilterGroup([Schema.isInt(), Schema.isBetween({...})], { title: "isInt32" })
```

- `.check(...)` keeps the schema's type, so `.fields`, `.make` and the rest still work afterwards.
- Structural filters (length, size, property count) only run after nested values
  parse successfully, even with `errors: "all"`.

---

## 7. Error-handling patterns

Source: `packages/effect/src/Schema.ts` (`SchemaError` ~line 1219),
`packages/effect/src/SchemaIssue.ts`, `SCHEMA.md` §Error Handling and Formatting
(~line 6548), §Middlewares (~line 6860).

### 7.1 What fails, and with what

- The `Schema.*` APIs fail with **`SchemaError`**, a `Data.TaggedError("SchemaError")`
  with `.issue: SchemaIssue.Issue` and a formatted `.message`. Narrow with
  `Schema.isSchemaError(u)`, or use `Effect.catchTag("SchemaError", ...)`.
- The `SchemaParser.*` APIs fail with the raw **`SchemaIssue.Issue`**. Use them only when
  you're building tooling that inspects issues directly.
- Defects and interruptions aren't schema issues. `Exit`/`Effect` variants keep them in
  the `Cause`, and `Result`/`Option` variants rethrow them.

### 7.2 Map schema errors into domain errors at the boundary

```ts
// ai-docs/src/01_effect/02_schema/10_schema-basics.ts
export class InvalidUserPayload extends Schema.TaggedError<InvalidUserPayload>()("InvalidUserPayload", {
  message: Schema.String
}) {}

export const parseUserPayload = Effect.fn("parseUserPayload")((input: unknown) =>
  decodeUser(input).pipe(
    Effect.mapError((error) => new InvalidUserPayload({ message: error.message }))
  )
)
```

Then recover by tag:

```ts
// SCHEMA.md §TaggedError
program.pipe(
  Effect.catchTags({
    NotFound: (err) => Effect.succeed(`Not found: ${err.path}`),
    Unauthorized: (err) => Effect.succeed(`Unauthorized: ${err.reason}`)
  })
)
```

To keep an unknown cause on an error, use `Schema.Defect()` as the field
(`LLMS.md`: `cause: Schema.Defect()`).

### 7.3 Inspect failures without throwing

```ts
// SCHEMA.md §Union examples (output checked against effect@4.0.7)
console.log(String(Schema.decodeUnknownExit(Schema.Literals(["a", "b"]))(null)))
// Failure(Cause([Fail(SchemaError(Expected "a" | "b"))]))
// Some SCHEMA.md snippets print "SchemaError: …"; the real toString is "SchemaError(…)".
```

### 7.4 Format errors for users or APIs

```ts
// SCHEMA.md §Hooks: a Standard Schema-shaped { issues: [{ path, message }] }
Schema.decodeUnknownEffect(schema)(input, { errors: "all" }).pipe(
  Effect.mapError((error) => SchemaIssue.makeFormatterStandardSchemaV1()(error.issue))
)
```

- To customise messages per schema, use `.annotate({ message })`,
  `.annotateKey({ messageMissingKey })` and `Schema.isNonEmpty({ message })`.
- To label a schema in type-mismatch messages, use `.annotate({ identifier: "Username" })`.
  An identifier does *not* rename a failed filter; use the filter's `expected` or
  `message` for that.
- If something else expects Standard Schema (forms, tRPC-style validators), use
  `Schema.toStandardSchemaV1(schema)`.
- `SchemaError` does **not** include the rejected input unless you pass
  `{ reportInput: true }`. Leave it off for anything that might carry API keys,
  prompts or user PII.

### 7.5 Fallbacks instead of failure

```ts
// SCHEMA.md §Fallbacks; test/schema/Schema.test.ts "catchDecoding"
const schema = Schema.String.pipe(Schema.catchDecoding(() => Effect.succeedSome("b")))
// decodes null → "b"

// Drop a bad optional field rather than failing the whole object
Schema.Struct({
  a: Schema.optionalKey(Schema.String).pipe(Schema.catchDecoding(() => Effect.succeedNone))
})
```

Use fallbacks sparingly, for tolerant parsing of third-party responses. Silent
defaults on *inputs we own* hide bugs.

---

## 8. Secrets

```ts
// migration/schema.md §Redacted
const ApiKey = Schema.RedactedFromValue(Schema.String)   // decodes "sk-…" into Redacted<string>
```

- `Schema.RedactedFromValue(S)` decodes a raw value and wraps it in `Redacted`.
  Use it for env vars and API tokens such as the Cloudflare or BytePlus keys.
- `Schema.Redacted(S)` expects the input to **already** be a `Redacted`. This is the
  opposite of v3, where `Schema.Redacted` decoded raw values.

---

## 9. What to avoid

| Don't | Do instead | Source |
| --- | --- | --- |
| `import … from "@effect/schema"` or anything under `repos/` | `import { Schema } from "effect"` | `AGENTS.md`; v4 ships Schema in `effect` |
| `Schema.Union(A, B)`, `Schema.Tuple(A, B)`, `Schema.Literal("a", "b")` | `Union([A, B])`, `Tuple([A, B])`, `Literals(["a", "b"])` | `migration/schema.md` summary |
| `Schema.Record({ key, value })` | `Schema.Record(key, value)` | same |
| `Schema.transform(from, to, …)` / `transformOrFail` | `from.pipe(Schema.decodeTo(to, SchemaTransformation.transform / transformEffect(...)))` | same |
| `Schema.filter(pred)`, `minLength(…)`, `positive()` | `.check(Schema.makeFilter(pred))`, `isMinLength(…)`, `isGreaterThan(0)` | §Filter renames |
| `Schema.decodeUnknown`, `decodeUnknownEither`, `ParseResult.*` | `decodeUnknownEffect`, `decodeUnknownExit` / `decodeUnknownResult`, `SchemaIssue.*` | summary table |
| `Schema.Date` to parse ISO strings | `Schema.DateFromString` (`Schema.Date` = a `Date` object) | §`Date` encoded contract |
| `Schema.Redacted(Schema.String)` for raw secrets | `Schema.RedactedFromValue(Schema.String)` | §Redacted |
| `.pick` / `.omit` / `partial` / `extend` on structs | `.mapFields(Struct.pick/omit/map(...))`, `Schema.fieldsAssign` | summary table |
| `JSON.parse` then decode | `Schema.fromJsonString(schema)` | `SCHEMA.md` §fromJsonString |
| Throwing inside a transformation | `Effect.fail(new SchemaIssue.InvalidValue(annotations, input, options))` | §Defining an Inline Transformation |
| Async work inside `.check(...)` | `SchemaGetter.checkEffect` in `Schema.decode({ ... })` | §Effectful Filters |
| `Schema.brand(...)` alone as validation | `.check(...)` and then `.pipe(Schema.brand(...))` | §Branding (brands are type-only) |
| Re-creating parsers per call, e.g. `Schema.decodeUnknownSync(S)(x)` in a hot loop | Hoist `const decode = Schema.decodeUnknownSync(S)` | `10_schema-basics.ts` |
| `decodeUnknownSync` deep inside Effect code | `decodeUnknownEffect` so the error stays typed | `10_schema-basics.ts` |
| `class Child extends SomeSchemaClass` | `SomeSchemaClass.extend<Child>("Child")({ … })` | §extend |
| Hand-written `interface` duplicating a schema | `typeof S.Type` / `typeof S.Encoded` | §Model types |
| `{ reportInput: true }` on payloads with secrets/PII | Leave it off (the default) | §Reporting Rejected Inputs |
| `import { Getter, Parser } from "effect/schema"` (stale doc snippet) | `SchemaGetter`, `SchemaParser` from `"effect"` | `src/schema/index.ts` |
| Assuming v3 docs or blog posts apply | Grep `packages/effect/src/Schema.ts` and `SCHEMA.md` | — |

---

## 10. Checklist before you commit Schema code

1. Every name you used exists in `repos/effect/packages/effect/src/Schema*.ts`.
2. Schemas live next to the boundary they guard: request bodies, provider responses,
   Trigger.dev payloads, env config.
3. Parsers are hoisted (`const decodeX = Schema.decodeUnknownEffect(X)`).
4. Effect code uses `*Effect` decoders and maps `SchemaError` into a domain
   `Schema.TaggedError` at the edge.
5. Transformations that can fail use `transformEffect` / `SchemaGetter.transformEffect`
   with `SchemaIssue`s, never `throw`.
6. Secrets use `RedactedFromValue`, and `reportInput` stays off.
