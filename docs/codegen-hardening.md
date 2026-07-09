# Codegen Hardening

Generated policy code is the highest-risk path in OZ Policy Builder. Agents must treat it as a separate visible workflow, not as the same confidence level as configuring known OZ or pb policies.

## Agent Workflow

1. Use `ozpb_match_policies`.
2. If existing policies cover the constraint, stay in composition mode.
3. If the result requires fresh Rust, call `ozpb_generate_custom_policy_code`.
4. Call `ozpb_materialize_generated_policy`.
5. Review `REVIEW.md` and `codegen_manifest.json`.
6. Call `ozpb_compile_generated_policy`.
7. Run real allow/deny verification with Docker/fork.
8. Call `ozpb_review_generated_policy` with the compile result and simulation report hash.
9. Only after the review gate returns `deployment_allowed: true` may an install plan be prepared.

## Hard Rules

- Generated code is never deployed automatically.
- Generated code is never hidden inside `ozpb_draft_policy_from_recording`.
- The agent may only repair code inside `// >>> GENERATED:` and `// <<< GENERATED` fenced regions.
- A generated crate with `build.rs`, untracked dependencies, missing review docs, missing manifest region mapping, failed compile, or missing simulation evidence is not install-ready.
- Review must map each generated region back to constraint IDs.

## Current Template Families

- `context_guard`: fixed-function argument checks.
- `cross_arg_lt`: normalized into a `context_guard` cross-argument comparison.

Supported checks:

- `arg_i128_range`
- `arg_u32_eq`
- `cross_arg_compare`

Unsupported constraints must fail closed with `E_C3_UNEXPRESSIBLE`; they must not be approximated by broader permissions.

## Production Gate

`ozpb_review_generated_policy` is the final static gate for generated crates. It returns `deployment_allowed: false` unless all of these are true:

- `codegen_manifest.json` parses.
- `REVIEW.md` contains the review warning.
- No `build.rs` exists.
- Every generated region has start/end markers.
- Every generated region maps to at least one constraint.
- Dependencies are limited to the generated-policy allowlist.
- `ozpb_compile_generated_policy` passed.
- A real Docker/fork simulation report hash is attached.
