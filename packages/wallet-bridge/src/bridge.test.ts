import { describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import { WalletBridge } from "./bridge.js";
import { samplePayload, sampleResult } from "./testkit.js";

describe("WalletBridge", () => {
  it("T-WB.browser-smoke: approval page loads and request can be rejected", async () => {
    const bridge = new WalletBridge();
    try {
      const approval = await bridge.createSigningRequest({
        kind: "sign_install_plan",
        network: "testnet",
        payload: samplePayload(),
      });
      const url = new URL(approval.approval_url);
      const page = await fetch(`${url.origin}${url.pathname}`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("OZ Policy Builder Approval");
      expect(html).toContain('/assets/companion.js');
      expect(html).not.toContain("esm.sh");
      expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");

      const asset = await fetch(`${url.origin}/assets/companion.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("content-type")).toContain("text/javascript");
      expect(await asset.text()).toContain("smart-account-kit");

      const bearer = `${approval.sid}.${url.hash.slice(1)}`;
      const reject = await fetch(`${url.origin}/api/reject/${approval.sid}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, Origin: url.origin },
      });
      expect(reject.status).toBe(200);
      expect((await bridge.waitForResult(approval.sid, 100)).status).toBe("rejected");
    } finally {
      await bridge.stop();
    }
  });

  it("T-WB.sign-plan-mock: mocked signing callback is accepted", async () => {
    const bridge = new WalletBridge();
    try {
      const planHash = "a".repeat(64);
      const approval = await bridge.createSigningRequest({
        kind: "sign_install_plan",
        network: "testnet",
        payload: samplePayload(),
        plan_hash: planHash,
      });
      const url = new URL(approval.approval_url);
      const bearer = `${approval.sid}.${url.hash.slice(1)}`;
      const result = sampleResult(approval.sid, planHash);
      const response = await fetch(`${url.origin}/api/result/${approval.sid}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          Origin: url.origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(result),
      });

      expect(response.status).toBe(200);
      const completed = await bridge.waitForResult(approval.sid, 100);
      expect(completed.status).toBe("completed");
      expect(completed.result?.signed_steps).toHaveLength(1);
    } finally {
      await bridge.stop();
    }
  });

  it("T-WB.host-check: wrong Host header rejected", async () => {
    const bridge = new WalletBridge();
    try {
      const origin = await bridge.start();
      const url = new URL(origin);
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: url.hostname,
            port: Number(url.port),
            path: "/healthz",
            method: "GET",
            headers: { Host: "evil.local" },
          },
          (res) => {
            res.resume();
            res.on("end", () => resolve(res.statusCode ?? 0));
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(status).toBe(403);
    } finally {
      await bridge.stop();
    }
  });
});
