import path from "path";
import fs from "fs";
import { config as dotenvConfig } from "dotenv";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Wallet } from "ethers";
import { Agent } from "undici";

// Load plugin-specific env first, then fall back to process defaults
const envPath = path.resolve(__dirname, "..", "..", ".env.health-guardian");
if (fs.existsSync(envPath)) {
  dotenvConfig({ path: envPath });
}
dotenvConfig();

// Connect to the main server instead of starting our own
const MCP_SERVER_URL = process.env.HG_AGENT_MCP_URL || process.env.EXPO_PUBLIC_MCP_URL || "http://localhost:9200";
const ACCESS_TOKEN = process.env.HG_AGENT_ACCESS_TOKEN; // Required for OAuth authentication

const MIN_INTERVAL_MS = Number(process.env.HG_AGENT_MIN_INTERVAL_MS || 10_000);
const PREMIUM_AMOUNT = Number(process.env.HG_AGENT_PREMIUM_AMOUNT || 1);
const RUN_COUNT = Number(process.env.HG_AGENT_RUN_COUNT || 4);
const RECEIVER_OVERRIDE =
  process.env.HG_AGENT_PREMIUM_RECEIVER ||
  process.env.HG_PREMIUM_RECEIVER_ADDRESS;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function extractField<T = any>(result: any, key: string): T | undefined {
  return result?.[key] ?? result?.structuredContent?.[key];
}

/**
 * Generate a health claim using the agent's LLM
 */
async function generateHealthClaim(serverUrl: string, accessToken: string): Promise<string> {
  const llmUrl = `${serverUrl}/llm`;
  
  const response = await fetch(llmUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      messages: [
        {
          role: "user",
          content: "Generate a realistic health claim that could be fact-checked. Examples: 'Ashwagandha supplements increase muscle strength', 'Intermittent fasting reverses type 2 diabetes in all cases', 'Vitamin D alone prevents respiratory infections'. Return only the claim text, nothing else."
        }
      ],
    }),
  });

  if (!response.ok) {
    if (response.status === 401) throw new Error("Unauthorized - check your access token");
    if (response.status === 403) throw new Error("Forbidden - token may not have 'llm' scope");
    throw new Error(`LLM request failed: ${response.status} ${response.statusText}`);
  }

  const result = await response.json();
  const claim = typeof result.content === 'string' 
    ? result.content 
    : Array.isArray(result.content) 
      ? result.content.map((c: any) => c.text || c).join(' ')
      : JSON.stringify(result.content);
  
  // Clean up the claim (remove quotes, extra whitespace)
  return claim.trim().replace(/^["']|["']$/g, '').trim();
}

async function main() {
  // Validate that we have an access token
  if (!ACCESS_TOKEN) {
    console.error("❌ Error: HG_AGENT_ACCESS_TOKEN environment variable is required.");
    console.error("\nTo create an access token:");
    console.error("1. Start the main server: cd apps/agent && npm run dev:server");
    console.error("2. Create a token: npm run script:createToken");
    console.error("3. Enter scope: mcp llm (required for claim generation)");
    console.error("4. Set the token: export HG_AGENT_ACCESS_TOKEN=<your-token>");
    console.error("\nAlternatively, add it to .env.health-guardian:");
    console.error("HG_AGENT_ACCESS_TOKEN=<your-token>");
    process.exit(1);
  }

  console.log(`🔌 Connecting to MCP server at ${MCP_SERVER_URL}/mcp`);
  console.log(`🔑 Using OAuth token: ${ACCESS_TOKEN.substring(0, 8)}...`);

  const client = new Client({ name: "hg-agent-cli", version: "0.0.1" });

  // Configure undici agent with long timeouts for DKG operations
  const dispatcher = new Agent({
    headersTimeout: 600000, // 10 minutes
    bodyTimeout: 600000,    // 10 minutes
    connectTimeout: 60000,  // 1 minute to connect
  });

  // Custom fetch that always includes Authorization header and uses long timeouts
  const customFetch = (url: URL | string, options?: RequestInit) => {
    const headers = new Headers(options?.headers);
    headers.set('Authorization', `Bearer ${ACCESS_TOKEN}`);

    return fetch(url, {
      ...options,
      headers,
      // @ts-ignore - dispatcher is valid for Node.js fetch
      dispatcher,
    });
  };

  const transport = new StreamableHTTPClientTransport(
    new URL(`${MCP_SERVER_URL}/mcp`),
    {
      fetch: customFetch,
    }
  );
  await client.connect(transport);

  console.log("🤖 Agent-to-agent loop connected to MCP");

  // Wait for tools to be registered (service init is async)
  const waitForTools = async (toolNames: string[], timeoutMs = 30000) => {
    const start = Date.now();
    while (true) {
      const { tools } = await client.listTools();
      const found = toolNames.every((t) => tools.some((x) => x.name === t));
      if (found) break;
      if (Date.now() - start > timeoutMs) {
        throw new Error(
          `Timed out waiting for tools: ${toolNames.join(", ")}; found: ${tools
            .map((t) => t.name)
            .join(", ")}`,
        );
      }
      await sleep(500);
    }
  };

  const requiredTools = [
    "analyze-health-claim",
    "publish-health-note",
    "access-premium-health-insights",
  ];

  await waitForTools(requiredTools);

  // Rate-limited tool caller
  let lastCallTs = 0;
  const callTool = async (name: string, args: Record<string, unknown>) => {
    const elapsed = Date.now() - lastCallTs;
    if (elapsed < MIN_INTERVAL_MS) {
      const wait = MIN_INTERVAL_MS - elapsed;
      console.log(`⏳ Throttling "${name}" for ${wait}ms`);
      await sleep(wait);
    }

    lastCallTs = Date.now();
    console.log(`➡️  Calling ${name}...`);
    const result = await client.callTool(
      {
        name,
        arguments: args,
      },
      undefined,
      {
        timeout: 480000, // 8 minutes for DKG publishing
      }
    );
    console.log(`⬅️  ${name} completed`);
    return result as any;
  };

  // Run the flow multiple times
  console.log(`🔄 Running agent flow ${RUN_COUNT} time(s)...\n`);

  for (let run = 1; run <= RUN_COUNT; run++) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`📋 Run ${run} of ${RUN_COUNT}`);
    console.log(`${"=".repeat(60)}\n`);

    // 1) Generate a health claim using the agent's LLM
    console.log("🧠 Generating health claim using LLM...");
    let claim: string;
    try {
      claim = await generateHealthClaim(MCP_SERVER_URL, ACCESS_TOKEN);
      console.log(`✅ Generated claim: "${claim}"`);
    } catch (error) {
      console.error("❌ Failed to generate claim with LLM:", error);
      console.log("⚠️  Falling back to sample claim...");
      // Fallback to a sample claim if LLM fails
      claim = "Ashwagandha supplements increase muscle strength.";
      console.log(`📝 Using fallback claim: "${claim}"`);
    }

    // 2) Analysis agent evaluates the claim
    const analysisRes = await callTool("analyze-health-claim", {
      claim,
      context: "Automated agent-to-agent health validation demo",
    });
    const claimId =
      extractField<string>(analysisRes, "claimId") ||
      `claim_${Date.now()}`; // fallback for mock mode
    const analysis = extractField<any>(analysisRes, "analysis") || {};

    // 3) Publishing agent writes to the DKG
    const publishRes = await callTool("publish-health-note", {
      claimId,
      summary:
        analysis.summary ||
        "Automated publish from agent-to-agent flow (no summary in analysis payload).",
      confidence: analysis.confidence ?? 0.5,
      verdict: analysis.verdict || "uncertain",
      sources: analysis.sources || ["Not provided"],
    });
    const noteId =
      extractField<string>(publishRes, "noteId") || `note_${Date.now()}`;
    const ual = extractField<string>(publishRes, "ual") || "did:dkg:mock";

    console.log(
      `📡 Published note ${noteId} with UAL ${ual} — check Neuroweb explorer to confirm minting/rewards.`,
    );

    // 4) Premium payment agent unlocks premium view
    const receiver =
      RECEIVER_OVERRIDE || Wallet.createRandom().address.toString();

    const premiumRes = await callTool("access-premium-health-insights", {
      noteId,
      paymentAmount: PREMIUM_AMOUNT,
      recipient: receiver,
    });
    const txHash = extractField<string>(premiumRes, "transactionHash") || "n/a";
    const paidTo = extractField<string>(premiumRes, "paidTo") || receiver;

    console.log(
      `💎 Premium unlocked via tx ${txHash}\n    Paid from DKG_PUBLISH_WALLET to ${paidTo}\n    Explorer link (if provided): ${
        extractField<string>(premiumRes, "explorerLink") || "not available"
      }`,
    );

    console.log(`✅ Run ${run} of ${RUN_COUNT} complete.\n`);

    // Add delay between runs (except after the last one)
    if (run < RUN_COUNT) {
      console.log(`⏸️  Waiting before next run...\n`);
      await sleep(MIN_INTERVAL_MS);
    }
  }

  console.log("✅ Agent-to-agent flow complete - all runs finished.");
}

main().catch((err) => {
  console.error("Agent-to-agent flow failed:", err);
  process.exit(1);
});
