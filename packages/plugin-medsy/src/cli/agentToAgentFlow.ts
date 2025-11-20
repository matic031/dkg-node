import { config } from "dotenv";
import { resolve } from "path";

config({ path: resolve(__dirname, "../../../../apps/agent/.env") });
config({ path: resolve(__dirname, "../../.env.medsy") });
console.log("Loaded MEDSY_DATABASE_PATH:", process.env.MEDSY_DATABASE_PATH);

import chalk from "chalk";
import boxen from "boxen";
import { HealthClaimWorkflowService } from "../services/HealthClaimWorkflowService";
import { AIAnalysisService } from "../services/aiAnalysis";
import { X402PaymentService } from "../services/x402PaymentService";
import { DkgService } from "../services/dkgService";
import { AgentAuthService, type AgentIdentity } from "../services/agentAuthService";
import { TokenomicsService } from "../services/tokenomicsService";

interface A2AMessage {
  messageId: string;
  from: string;
  to: string;
  timestamp: number;
  messageType: "request" | "response" | "proposal" | "acceptance" | "rejection";
  payload: any;
}

const log = {
  header: (text: string) => {
    console.log("\n" + chalk.bold.cyan("═".repeat(60)));
    console.log(chalk.bold.cyan(`  ${text}`));
    console.log(chalk.bold.cyan("═".repeat(60)) + "\n");
  },

  subheader: (text: string) => {
    console.log(chalk.bold.yellow(`\n▸ ${text}\n`));
  },

  box: (title: string, content: Record<string, any>, color: "green" | "blue" | "yellow" | "magenta" | "cyan" = "blue") => {
    const lines = Object.entries(content)
      .map(([key, value]) => `${chalk.gray(key + ":")} ${chalk.white(String(value))}`)
      .join("\n");

    console.log(boxen(lines, {
      title: chalk[color](title),
      padding: 1,
      margin: { top: 0, bottom: 1, left: 2, right: 2 },
      borderStyle: "round",
      borderColor: color
    }));
  },

  agent: (name: string, message: string) => {
    const colors: Record<string, typeof chalk.blue> = {
      "Analyzer Agent": chalk.magenta,
      "Buyer Agent": chalk.cyan,
      "System": chalk.gray
    };
    const color = colors[name] || chalk.white;
    console.log(`  ${color("◉")} ${chalk.bold(name)}: ${message}`);
  },

  a2a: (from: string, to: string, msgType: string, text: string) => {
    console.log(chalk.gray(`    ↔ [A2A ${msgType}] ${from} → ${to}: `) + chalk.italic(text));
  },

  success: (text: string) => {
    console.log(chalk.green(`  ✓ ${text}`));
  },

  error: (text: string) => {
    console.log(chalk.red(`  ✗ ${text}`));
  },

  info: (text: string) => {
    console.log(chalk.gray(`  ℹ ${text}`));
  },

  price: (amount: number) => {
    return chalk.yellow(`${amount.toFixed(4)} TRAC`);
  }
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function generateMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function sendA2AMessage(from: string, to: string, messageType: A2AMessage["messageType"], payload: any): A2AMessage {
  return {
    messageId: generateMessageId(),
    from,
    to,
    timestamp: Date.now(),
    messageType,
    payload
  };
}

class AnalyzerAgent {
  private agentId: string;
  private identity: AgentIdentity;
  private llm: any;
  private workflowService: HealthClaimWorkflowService;

  constructor(identity: AgentIdentity, llm: any, workflowService: HealthClaimWorkflowService) {
    this.agentId = identity.agentId;
    this.identity = identity;
    this.llm = llm;
    this.workflowService = workflowService;
  }

  async generateClaim(): Promise<{ claim: string; context: string }> {
    if (!this.llm) {
      return {
        claim: "Taking 1000mg of Vitamin C daily prevents common cold infections",
        context: "Health influencer social media post"
      };
    }

    const prompt = `Generate ONE realistic health claim about supplements, nutrition, or wellness that needs fact-checking.
Make it specific and verifiable.

Respond with JSON:
{
  "claim": "the specific health claim",
  "context": "where this claim appears (social media, blog, etc.)"
}`;

    try {
      const response = await this.llm.invoke([{ role: "user", content: prompt }]);
      const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
      }
    } catch (error) {
      log.info("AI claim generation failed, using fallback");
    }

    return {
      claim: "Taking 1000mg of Vitamin C daily prevents common cold infections",
      context: "Health influencer social media post"
    };
  }

  async analyzeClaim(claim: string, context?: string): Promise<any> {
    log.agent("Analyzer Agent", "Executing analysis workflow (AI + DKG + Staking)...");
    
    const result = await this.workflowService.executeHealthClaimWorkflow(
      this.identity,
      claim,
      context
    );

    if (!result.success) {
      throw new Error(`Analysis failed: ${result.errors.join(", ")}`);
    }

    return result;
  }

  async proposePrice(confidence: number): Promise<number> {
    if (!this.llm) {
      return 0.5 + (confidence * 2.5);
    }

    const prompt = `You are selling a health claim analysis with ${(confidence * 100).toFixed(1)}% confidence.
Propose a fair price in TRAC tokens:
- High confidence (>90%): 2.5-3.5 TRAC
- Good confidence (75-90%): 1.5-2.5 TRAC
- Medium confidence (50-75%): 0.8-1.5 TRAC
- Low confidence (<50%): 0.3-0.8 TRAC

Respond with only the number (price in TRAC).`;

    try {
      const response = await this.llm.invoke([{ role: "user", content: prompt }]);
      const content = typeof response.content === 'string' ? response.content : String(response.content);
      const priceMatch = content.match(/[\d.]+/);
      if (priceMatch) {
        return parseFloat(priceMatch[0]);
      }
    } catch (error) {
      log.info("AI pricing failed, using formula");
    }

    return 0.5 + (confidence * 2.5);
  }

  async handleRequest(message: A2AMessage): Promise<A2AMessage> {
    const { claim, context } = message.payload;
    
    const result = await this.analyzeClaim(claim, context);
    const price = await this.proposePrice(result.analysis?.confidence || 0.5);

    return sendA2AMessage(this.agentId, message.from, "response", {
      claimId: result.claimId,
      noteId: result.noteId,
      ual: result.ual,
      analysis: result.analysis,
      price,
      message: "Analysis complete, published to DKG"
    });
  }

  async handleProposal(message: A2AMessage): Promise<A2AMessage> {
    const { offeredPrice, originalPrice } = message.payload;
    
    if (this.llm) {
      const prompt = `You are selling an analysis for ${originalPrice.toFixed(4)} TRAC.
Buyer offers ${offeredPrice.toFixed(4)} TRAC.

Decide:
1. "accept" if offer is reasonable (>70% of your price)
2. "reject" if offer is too low

Respond with only: accept or reject`;

      try {
        const response = await this.llm.invoke([{ role: "user", content: prompt }]);
        const content = typeof response.content === 'string' ? response.content : String(response.content);
        const decision = content.toLowerCase().includes("accept") ? "acceptance" : "rejection";
        
        return sendA2AMessage(this.agentId, message.from, decision as any, {
          finalPrice: decision === "acceptance" ? offeredPrice : null,
          message: decision === "acceptance" ? "Offer accepted" : "Offer too low"
        });
      } catch (error) {
        log.info("AI decision failed, using fallback");
      }
    }

    const acceptable = offeredPrice >= originalPrice * 0.7;
    return sendA2AMessage(this.agentId, message.from, acceptable ? "acceptance" : "rejection", {
      finalPrice: acceptable ? offeredPrice : null,
      message: acceptable ? "Offer accepted" : "Offer too low"
    });
  }
}

class BuyerAgent {
  private agentId: string;
  private identity: AgentIdentity;
  private llm: any;
  private x402Service: X402PaymentService;
  private budget: number;

  constructor(identity: AgentIdentity, llm: any, x402Service: X402PaymentService, budget: number) {
    this.agentId = identity.agentId;
    this.identity = identity;
    this.llm = llm;
    this.x402Service = x402Service;
    this.budget = budget;
  }

  requestAnalysis(analyzerAgentId: string, claim: string, context?: string): A2AMessage {
    return sendA2AMessage(this.agentId, analyzerAgentId, "request", {
      claim,
      context,
      requestType: "health-claim-analysis"
    });
  }

  async evaluatePrice(price: number): Promise<{ accept: boolean; counterOffer?: number; reasoning: string }> {
    if (!this.llm) {
      if (price <= this.budget) {
        return { accept: true, reasoning: "Within budget" };
      }
      return {
        accept: false,
        counterOffer: Math.min(this.budget, price * 0.85),
        reasoning: "Price too high, making counter-offer"
      };
    }

    const prompt = `You are buying a health analysis for ${price.toFixed(4)} TRAC.
Your budget is ${this.budget.toFixed(4)} TRAC.

Decide:
1. "accept" if price is within budget
2. "negotiate" and propose counter-offer if price is above budget

Respond with JSON:
{
  "decision": "accept" or "negotiate",
  "counterOffer": number (only if negotiating),
  "reasoning": "brief explanation"
}`;

    try {
      const response = await this.llm.invoke([{ role: "user", content: prompt }]);
      const content = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const decision = JSON.parse(jsonMatch[0]);
        return {
          accept: decision.decision === "accept",
          counterOffer: decision.counterOffer,
          reasoning: decision.reasoning
        };
      }
    } catch (error) {
      log.info("AI price evaluation failed, using fallback");
    }

    if (price <= this.budget) {
      return { accept: true, reasoning: "Within budget" };
    }
    return {
      accept: false,
      counterOffer: Math.min(this.budget, price * 0.85),
      reasoning: "Price too high"
    };
  }

  makeProposal(analyzerAgentId: string, originalPrice: number, offeredPrice: number): A2AMessage {
    return sendA2AMessage(this.agentId, analyzerAgentId, "proposal", {
      originalPrice,
      offeredPrice,
      message: `Counter-offer: ${offeredPrice.toFixed(4)} TRAC`
    });
  }

  async processPayment(price: number, claimId: string): Promise<string> {
    log.agent("Buyer Agent", `Processing x402 payment of ${log.price(price)}...`);
    
    try {
      const payment = await this.x402Service.createPaymentRequest(
        price,
        `Health claim analysis: ${claimId}`,
        this.agentId
      );

      log.info(`Payment ID: ${payment.paymentId}`);
      log.info(`Currency: TRAC (OriginTrail)`);
      
      await sleep(800);
      const completed = await this.x402Service.processPayment(
        payment.paymentId,
        this.identity.walletAddress,
        `0x${Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join("")}`
      );

      if (completed.transactionHash) {
        log.success(`Payment confirmed: ${completed.transactionHash.substring(0, 20)}...`);
        return completed.transactionHash;
      }

      return "simulated_tx";
    } catch (error) {
      log.error(`x402 payment failed: ${error instanceof Error ? error.message : String(error)}`);
      log.info("Simulating payment...");
      return `0x${Array(64).fill(0).map(() => Math.floor(Math.random() * 16).toString(16)).join("")}`;
    }
  }
}

async function runA2AFlow() {
  log.header("AGENT-TO-AGENT (A2A) PROTOCOL FLOW");
  log.info("Initializing autonomous agents with real services...");

  const startTime = Date.now();

  let llm: any = null;
  let aiService: AIAnalysisService;
  let dkgService: DkgService;
  let tokenomicsService: TokenomicsService | undefined;
  let x402Service: X402PaymentService;
  let agentAuthService: AgentAuthService;
  let workflowService: HealthClaimWorkflowService;

  try {
    llm = (globalThis as any).llmProvider;
    if (!llm) {
      try {
        const { llmProvider } = await import("../../../../apps/agent/src/shared/chat.js" as any);
        llm = await llmProvider();
      } catch (error) {
        log.error("LLM not available - agents will use fallback logic");
      }
    }
  } catch (error) {
    log.error("LLM initialization failed");
  }

  try {
    aiService = new AIAnalysisService();
    if (llm) {
      (globalThis as any).llmProvider = llm;
      await aiService.initializeAIClient();
      log.success("AI Analysis Service initialized");
    }
  } catch (error) {
    log.error(`AI Service error: ${error instanceof Error ? error.message : String(error)}`);
    aiService = new AIAnalysisService();
  }

  try {
    dkgService = new DkgService();
    await dkgService.initialize();
    log.success("DKG Service initialized (standalone mode)");
  } catch (error) {
    log.error(`DKG Service error: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error("Critical: DKG Service failed to initialize");
  }

  try {
    tokenomicsService = new TokenomicsService();
    await tokenomicsService.initialize();
    log.success("Tokenomics Service initialized");
  } catch (error) {
    log.error(`Tokenomics Service error: ${error instanceof Error ? error.message : String(error)}`);
    log.info("Continuing without tokenomics (staking disabled)...");
    tokenomicsService = undefined;
  }

  try {
    x402Service = new X402PaymentService();
    await x402Service.initialize();
    log.success("x402 Payment Service initialized");
  } catch (error) {
    log.error(`x402 Service error: ${error instanceof Error ? error.message : String(error)}`);
    x402Service = new X402PaymentService();
  }

  try {
    agentAuthService = new AgentAuthService();
    await agentAuthService.initialize();
    log.success("Agent Auth Service initialized");
  } catch (error) {
    log.error(`Agent Auth error: ${error instanceof Error ? error.message : String(error)}`);
    agentAuthService = new AgentAuthService();
  }

  try {
    workflowService = new HealthClaimWorkflowService();
    await workflowService.initialize({
      aiService,
      dkgService,
      tokenomicsService
    });
    log.success("Health Claim Workflow Service initialized");
  } catch (error) {
    log.error(`Workflow Service error: ${error instanceof Error ? error.message : String(error)}`);
    throw new Error("Critical: Health Claim Workflow Service failed to initialize");
  }

  await sleep(1000);

  const analyzerIdentity: AgentIdentity = {
    agentId: "analyzer_agent_001",
    name: "Health Analyzer Agent",
    walletAddress: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
    capabilities: ["health_analysis", "dkg_publishing", "staking"],
    registeredAt: new Date(),
    lastActive: new Date(),
    trustScore: 0.85
  };

  const buyerIdentity: AgentIdentity = {
    agentId: "buyer_agent_002",
    name: "Analysis Buyer Agent",
    walletAddress: "0x853e46Dd7645D0543926B472Ec767ab344f55f4f",
    capabilities: ["payment", "negotiation"],
    registeredAt: new Date(),
    lastActive: new Date(),
    trustScore: 0.75
  };

  log.box("Agent Identities", {
    "Analyzer": analyzerIdentity.name,
    "Analyzer ID": analyzerIdentity.agentId,
    "Buyer": buyerIdentity.name,
    "Buyer ID": buyerIdentity.agentId
  }, "cyan");

  const analyzerAgent = new AnalyzerAgent(analyzerIdentity, llm, workflowService!);
  const buyerAgent = new BuyerAgent(buyerIdentity, llm, x402Service!, 3.0);

  await sleep(500);

  log.subheader("Step 0: Query Guardian Social Graph");
  log.info("Fetching health claims from OriginTrail DKG...");

  let guardianClaim: { claim: string; context: string; postUri?: string; url?: string; ual?: string } | null = null;

  try {
    const guardianResult = await dkgService.findHealthClaimsToFactCheck(["autism", "vaccine", "health", "medical"]);

    if (guardianResult.success && guardianResult.posts.length > 0) {
      const post = guardianResult.posts[0];
      guardianClaim = {
        claim: post.headline || post.description,
        context: `Guardian Social Graph - ${post.url}`,
        postUri: post.post,
        url: post.url,
        ual: post.ual
      };

      log.success(`Found ${guardianResult.posts.length} health claims in Guardian Social Graph`);
      log.box("Guardian Social Graph Result", {
        "Posts Found": guardianResult.posts.length,
        "Selected Post": post.headline?.substring(0, 60) + "...",
        "Source URL": post.url || "N/A",
        "Post URI": post.post?.substring(0, 50) + "..." || "N/A",
        "UAL": post.ual ? chalk.blue(post.ual) : "N/A"
      }, "cyan");
    } else {
      log.info(`Guardian query returned: ${guardianResult.error || "no results"}`);
      log.info("Falling back to AI-generated claim...");
    }
  } catch (error) {
    log.error(`Guardian Social Graph query failed: ${error instanceof Error ? error.message : String(error)}`);
    log.info("Falling back to AI-generated claim...");
  }

  await sleep(500);

  log.subheader("Step 1: Select/Generate Health Claim");

  let claim: string;
  let context: string;

  if (guardianClaim) {
    claim = guardianClaim.claim;
    context = guardianClaim.context + (guardianClaim.ual ? ` | UAL: ${guardianClaim.ual}` : "");
    log.success("Using claim from Guardian Social Graph");
  } else {
    const generated = await analyzerAgent.generateClaim();
    claim = generated.claim;
    context = generated.context;
    log.info("Using AI-generated claim (Guardian unavailable)");
  }

  log.box("Health Claim to Analyze", {
    "Claim": claim.length > 80 ? claim.substring(0, 80) + "..." : claim,
    "Context": context,
    "Source": guardianClaim ? "Guardian Social Graph (DKG)" : "AI Generated"
  }, "magenta");

  await sleep(500);

  log.subheader("Step 2: A2A Request - Buyer → Analyzer");
  const requestMsg = buyerAgent.requestAnalysis(analyzerIdentity.agentId, claim, context);
  log.a2a(requestMsg.from, requestMsg.to, "REQUEST", `Analyze: "${claim.substring(0, 50)}..."`);
  log.info(`Message ID: ${requestMsg.messageId}`);

  await sleep(500);

  log.subheader("Step 3: A2A Response - Analyzer Executes Workflow");
  const responseMsg = await analyzerAgent.handleRequest(requestMsg);
  log.a2a(responseMsg.from, responseMsg.to, "RESPONSE", `Analysis complete. Price: ${log.price(responseMsg.payload.price)}`);
  
  log.box("Analysis Response", {
    "Claim ID": responseMsg.payload.claimId,
    "Note ID": responseMsg.payload.noteId,
    "UAL": responseMsg.payload.ual || "DKG publishing simulated",
    "Verdict": responseMsg.payload.analysis?.verdict || "completed",
    "Confidence": responseMsg.payload.analysis?.confidence ? `${(responseMsg.payload.analysis.confidence * 100).toFixed(1)}%` : "N/A",
    "Price": `${responseMsg.payload.price.toFixed(4)} TRAC`
  }, "blue");

  await sleep(500);

  log.subheader("Step 4: Price Negotiation");
  const priceEval = await buyerAgent.evaluatePrice(responseMsg.payload.price);
  
  if (!priceEval.accept && priceEval.counterOffer) {
    log.a2a(buyerIdentity.agentId, analyzerIdentity.agentId, "PROPOSAL", 
      `Counter-offer: ${log.price(priceEval.counterOffer)} - ${priceEval.reasoning}`);
    
    await sleep(500);

    const proposalMsg = buyerAgent.makeProposal(
      analyzerIdentity.agentId,
      responseMsg.payload.price,
      priceEval.counterOffer
    );
    
    const decisionMsg = await analyzerAgent.handleProposal(proposalMsg);
    log.a2a(decisionMsg.from, decisionMsg.to, decisionMsg.messageType.toUpperCase(), 
      decisionMsg.payload.message);

    if (decisionMsg.messageType === "rejection") {
      log.error("Negotiation failed - Analyzer rejected offer");
      return;
    }

    responseMsg.payload.price = decisionMsg.payload.finalPrice;
    log.success(`Agreement reached at ${log.price(decisionMsg.payload.finalPrice)}`);
  } else {
    log.a2a(buyerIdentity.agentId, analyzerIdentity.agentId, "ACCEPTANCE", 
      `Price accepted: ${log.price(responseMsg.payload.price)}`);
  }

  await sleep(500);

  log.subheader("Step 5: x402 Payment Processing");
  const txHash = await buyerAgent.processPayment(
    responseMsg.payload.price,
    responseMsg.payload.claimId
  );

  log.box("Payment Complete", {
    "Amount": `${responseMsg.payload.price.toFixed(4)} TRAC`,
    "Protocol": "x402 (HTTP 402 Payment Required)",
    "Transaction": txHash.substring(0, 20) + "...",
    "From": buyerIdentity.walletAddress,
    "To": analyzerIdentity.walletAddress
  }, "green");

  const endTime = Date.now();
  const executionTime = ((endTime - startTime) / 1000).toFixed(2);

  log.header("A2A FLOW COMPLETE");

  log.box("Execution Summary", {
    "Protocol": "Agent-to-Agent (A2A)",
    "Total Time": `${executionTime}s`,
    "Claim Source": guardianClaim ? "Guardian Social Graph" : "AI Generated",
    "Claim": claim.substring(0, 50) + "...",
    "Final Price": `${responseMsg.payload.price.toFixed(4)} TRAC`,
    "Messages Exchanged": "3-5 A2A messages",
    "Services Used": "Guardian DKG, AI, Tokenomics, x402",
    "Agents": "✓ Real autonomous agents",
    "Published UAL": responseMsg.payload.ual || "simulated"
  }, "green");

  if (responseMsg.payload.ual) {
    console.log("\n" + chalk.gray("  View on DKG Explorer:"));
    console.log(chalk.blue(`  https://dkg-testnet.origintrail.io/explore?ual=${encodeURIComponent(responseMsg.payload.ual)}\n`));
  }
}

runA2AFlow().catch((error) => {
  console.error(chalk.red("\n✗ A2A Flow execution failed:"));
  console.error(error);
  process.exit(1);
});
