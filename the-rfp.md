OZ accounts policy builder
Added: Q2 2026

1. Scope of Work
Develop an AI-assisted toolkit (likely a combination of an MCP server and a Claude / agent skill) that helps developers and end users craft OpenZeppelin smart account policies and context rules from observed or simulated Stellar transactions. The core deliverable is a "record-and-generate" workflow: a user (or agent) executes a representative transaction sequence—for example, claiming yield on Blend and converting it to USDC—and the tool synthesizes a context rule plus the minimum set of policies that would permit exactly that flow, scoped tightly enough that a delegated third party (human or agent) can repeat the operation but cannot deviate from it. The deliverable is positioned as an MCP server / agent skill / developer tool, not a hosted service that auto-deploys policies on behalf of users. The tool generates reviewable policy code; deployment is always a separate, explicit step performed by the user (or by an agent operating under existing permissions).

2. Background & Context
OpenZeppelin's smart accounts framework for Stellar (built on Soroban smart accounts and the OZ accounts package) decomposes authorization into three composable elements: context rules (scope and lifetime bindings, e.g. "call transfer() on USDC for one year"), signers (the entities authorized to act), and policies—enforcement modules that add programmable constraints like spending limits, multisig thresholds, or time windows. A single context rule can attach up to 5 policies, evaluated through a defined lifecycle (install / can_enforce / enforce / uninstall).

The expressive power of this design is significant: the same primitive supports subscription billing, agent delegation, social recovery, and corporate treasury rails. The tradeoff is authoring complexity. Today, writing a custom policy means writing a Soroban contract that implements the Policy trait correctly, segregates storage by both smart account address and context rule ID (for stateful policies), handles the install/enforce/uninstall lifecycle, and gets audited. That bar is too high for most application developers, and effectively prohibitive for end users who want to delegate a narrow capability to an agent or service.

The most powerful unlock here is letting users start from a transaction they have already performed (or simulated). An AI-assisted toolkit can examine the effects of that transaction—which contracts were called, which functions were invoked, which assets moved, in what amounts, in what order—and from that derive a context rule plus the policies needed to permit a future invocation of that same flow, but only that flow. "Record this sequence, generate a policy that allows exactly this and nothing else."

This sits at the intersection of three priorities for Stellar in 2026: AI / agent-readiness of the network, smart account adoption (C-addresses), and developer experience improvements that make Soroban's expressive capabilities practical to use. The output is also defensively useful—agents acting under tightly scoped policies are categorically safer than agents holding full account keys, which matters as AI agents take on more autonomous on-chain roles.

OpenZeppelin involvement: OZ has been consulted on this RFP and indicated interest in participating as a technical reviewer rather than a co-owner. Design decisions and generated-code quality should be validated with the OZ accounts package maintainers, but the deliverable is independent of OZ's own roadmap.

Prior art: Tyler (kalepail on GitHub) has built kalepail/pollywallet as a basic MVP demonstrating the core record-and-generate concept in under a week of work. A demo video is available at https://youtu.be/vmFnCtkqQJA. Respondents should treat this as the existing starting point and scope their work around extending it to production-quality (audited synthesizer, MCP server, agent skill, wallet integration) rather than building from scratch.

3. Requirements
The deliverable is a developer/end-user-facing toolkit, not a new contract primitive. At minimum, submissions should cover:

A transaction recording / observation layer that can ingest either (a) a real on-chain transaction by hash on mainnet/testnet or (b) a locally simulated transaction (e.g., from a Soroban simulation against a forked state). The layer must extract structured information about which contracts were invoked, which functions, with which arguments, and the resulting state changes / token movements.

A context rule + policy synthesizer that converts the recorded transaction(s) into a proposed context rule (scope: which contracts and functions; lifetime: how long the permission lasts) plus the smallest set of policies needed to constrain the rule (e.g. spending limits derived from the observed amounts, frequency limits, time bounds). The synthesizer should bias toward minimal permissions -- if a transaction sequence only ever calls two functions with two specific assets, the generated rule should not permit a third.

Generated policy code in Rust, suitable for compilation as a Soroban contract, leveraging existing OZ-provided policy primitives (simple_threshold, weighted_threshold, spending_limit) wherever they suffice. The tool should compose existing policies first and only generate net-new policy contracts when the constraint cannot be expressed by combining standard ones. Where new policy code is generated, it must implement the Policy trait correctly, including proper storage segregation for stateful cases.

An MCP server that exposes the recording, synthesis, and verification capabilities to agents, so that an AI agent can both request a policy be drafted from a sample transaction and operate under that policy once installed. The MCP interface should be agent-friendly: structured inputs/outputs, deterministic behavior, machine-readable error codes. Get inspiration from the Cloudflare Agent Setup and how they handle plugins, mcp and skills.

An Agent skill (or equivalent for other agent frameworks) that wraps the MCP and gives an agent a high-level conversational entry point: "the user wants to grant permission to do X; here is a transaction they performed; draft a policy." The skill should know when to ask for clarification (e.g., "this transaction transferred 50 USDC -- should the policy cap at 50, or allow up to 100 over a week?"). Can be for Claude and similar tools.

A simulation / dry-run harness that tests a generated policy against (a) the original recorded transaction (must permit), (b) a set of adjacent transactions that should be denied (e.g., same operations but different asset, larger amount, or out-of-window timing), so the user can verify the policy is neither too strict nor too permissive before installing it.

Integration with at least one existing Stellar wallet supporting OZ smart accounts (e.g., a wallet from the C-Address Tooling cohort) so the policy install flow is end-to-end demonstrable: record -> generate -> simulate -> sign -> install on a real smart account.

Documentation and examples covering at least three end-to-end policy generation walkthroughs from real Stellar use cases (Tyler suggested Blend yield-claim flows; other candidates include subscription billing on a SEP-41 token, delegated trading on Soroswap with bounded slippage).

Configurable composition / generation mode -- the synthesizer must support both modes: (a) configuring existing OZ policy contracts (simple_threshold, weighted_threshold, spending_limit) where they can express the constraint, and (b) generating fresh policy contracts where they cannot. The user should be able to inspect and modify generated policy code before deployment, not be forced into a fully automatic flow.

Code-first, deploy-second workflow -- the tool produces human-readable, reviewable policy code as its primary output. Deployment is never automatic. The user (or a separately-authorized agent) reviews the generated code, optionally modifies it, and then deploys it as a discrete step.

Open source, permissive license.

4. Evaluation Criteria
Technical capability -- demonstrated experience with Soroban contract development, Rust, and ideally with OpenZeppelin's accounts framework specifically. Prior work building MCP servers or AI tooling is a strong differentiator.

Relevant experience -- prior projects involving authorization frameworks, account abstraction (Stellar or otherwise), or codegen tooling. Teams that have shipped agent-facing tooling (MCPs, agent skills) will be weighted more heavily.

Security & audit history -- this tool generates code that runs as authorization logic on user funds. Any team submitting must be able to articulate a clear story for verifying generated policies, including how the simulation harness tests deny-cases, and must commit to an audit of the synthesizer logic itself (not just sample outputs).

Coordination with OpenZeppelin -- OZ has been consulted on this RFP and indicated interest in participating as a technical reviewer (not a co-owner). Submissions should describe how they will engage OZ as a technical reviewer: sharing design decisions on policy library composition, getting feedback on generated code quality, and aligning on what primitives would be valuable to upstream into the OZ accounts package.

Ecosystem alignment -- commitment to integrate with at least one existing Stellar smart-account-supporting wallet and to coordinate with the C-Address Tooling cohort.

Ability to deliver within a relatively short timeline.

Coherent integration plan -- a clear story for how the toolkit fits into existing developer and agent workflows, not just a standalone demo.

Building on existing work -- submissions should explicitly address what they will adopt, extend, or replace from kalepail/pollywallet. Greenfield rewrites should be justified.

5. Expected Deliverables
MCP server (open source) implementing the recording, synthesis, simulation, and verification capabilities.

Claude skill (or equivalent agent integration) wrapping the MCP server with a conversational interface.

Policy synthesizer library (Rust + supporting tooling) that produces compilable Soroban policy code.

Simulation / dry-run harness with permit-case and deny-case test generation.

Reference integration with at least one Stellar smart-account-supporting wallet, demonstrating the end-to-end record -> generate -> simulate -> install -> use flow.

Three documented end-to-end walkthroughs (Blend yield, SEP-41 subscription, bounded Soroswap delegation, or equivalents).

Developer documentation: how to use the toolkit, how the synthesizer makes scoping decisions, how to extend it with new policy primitives.

Test suite covering the synthesizer's correctness on a range of input transaction shapes.

Security audit of the synthesizer + generated policy templates, with findings remediated.

Production-ready release with versioned MCP server endpoint and packaging for the Agent skill (e.g. for Claude + others).