export function renderCompanionHtml(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>OZ Policy Builder Approval</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; background: #f7f7f5; color: #151515; }
      main { max-width: 920px; margin: 0 auto; padding: 32px 20px; }
      section { background: white; border: 1px solid #dad8d0; border-radius: 8px; padding: 18px; margin: 16px 0; }
      button { border: 1px solid #1b1b1b; background: #1b1b1b; color: white; border-radius: 6px; padding: 10px 14px; margin-right: 8px; cursor: pointer; }
      button.secondary { background: white; color: #1b1b1b; }
      pre { overflow: auto; background: #f1f1ee; padding: 12px; border-radius: 6px; }
      .muted { color: #666; }
      .error { color: #9b1c1c; }
      .success { color: #146c2e; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; }
    </style>
  </head>
  <body>
    <main>
      <h1>OZ Policy Builder Approval</h1>
      <p class="muted">Review the exact request. Owner keys stay in this browser/wallet surface.</p>
      <section id="status">Loading request...</section>
      <section id="details" hidden>
        <h2 id="kind"></h2>
        <p><strong>Network:</strong> <span id="network"></span></p>
        <p><strong>Plan hash:</strong> <span id="planHash"></span></p>
        <h3>Summary</h3>
        <pre id="summary"></pre>
        <h3>Policy diff</h3>
        <pre id="diff"></pre>
        <h3>Risk</h3>
        <pre id="risk"></pre>
        <h3>Steps</h3>
        <pre id="steps"></pre>
        <div class="row">
          <button id="createWallet" hidden>Create wallet</button>
          <button id="connectWallet" hidden>Connect wallet</button>
          <button id="runOneOff" hidden>Approve and run action</button>
          <button id="mockApprove">Mock approve</button>
          <button class="secondary" id="reject">Reject</button>
        </div>
      </section>
    </main>
    <script type="module" src="/assets/companion.js"></script>
  </body>
</html>`;
}
