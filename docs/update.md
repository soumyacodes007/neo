Report

  We proved the real wallet bridge path on Stellar testnet.

  Implemented/fixed:

  - Browser companion now uses local bundled JS, not CDN.
  - smart-account-kit passkey flow is wired into the wallet bridge.
  - Fixed account mismatch by targeting the stored credential/account.
  - Fixed OZ auth payload shape:
      - uses AuthPayload { context_rule_ids, signers }
      - signs OZ auth digest, not raw payload

  - Fixed WebAuthn failure:
      - forced rpId: "localhost"
      - required platform/internal authenticator
      - required User Verified passkey assertions
      - added local flag validation before RPC

  - Created fresh real testnet OZ smart account:
      - account: CBKK43WTYYG3CZT4PKCDQDYRVI4RLOJ7MM2BBGPN7W4YTEJEFQBO4TXM
      - deploy tx: 9127fe90dbb802be375525142a742403037acc8d050c99ba1d0622f14e4ffa3f

  - Installed real session-rule on testnet:
      - install tx: 5c8bd05ddd4f19ae365a2f372f2a457baf74a61de1abce566a4801357fe04321
      - rule name: ozpb-1
      - rule id: 1
      - account rule count: 1 -> 2

  - Stored reproducible fixture:
      - fixtures/testnet/phase8-wallet-demo-result.json
      - fixtures/testnet/phase8-session-rule-install-result.json

  - Ran verification:
      - wallet bridge build passes
      - wallet bridge tests pass
      - real trace/extract evidence ran
      - coverage smoke:
          - matching action: covered
          - amount+1: denied
          - wrong function: denied

  Main Problem Solved

  The biggest integration risk is now solved:

  browser passkey approval -> smart-account-kit -> OZ smart account __check_auth ->
  add_context_rule -> real testnet readback

  This means our local browser bridge can safely mutate a real OZ smart account without giving
  the agent the user’s passkey.

  Still Left

  1. Session-key use flow
     Prove rule 1 lets the Ed25519 session key execute a matching transaction without passkey
     approval.

  2. Changed-action fallback
     Prove changed transaction routes back to human/passkey approval.

  3. Strict final policy install
     Current real install is broad demo scope: native token contract + threshold.
     Final version needs tight recipient/function/amount constraints.

  4. Real allow/deny simulation
     Run full allow/deny battery on fork/testnet:
      - allowed case passes
      - amount+1 fails
      - wrong recipient fails
      - wrong function fails
      - expired rule fails

  5. Multi-policy install
     Re-enable and verify spending-limit/custom policy install after sorting/encoding is
     confirmed.

  6. MCP final wrapping
     Expose the full flow cleanly as MCP tools:
      - record
      - trace
      - extract
      - synthesize
      - simulate
      - explain
      - approve/install
      - use session key

  7. Submission polish
     Final docs, walkthroughs, fixtures, demo script, and README need to present the full
     record -> generate -> approve -> install -> repeat-without-passkey story.