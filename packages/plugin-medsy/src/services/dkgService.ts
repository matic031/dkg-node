import DKG from "dkg.js";
import { DKG_CONFIG } from "../config";
import type { DkgPublishResult, DkgAsset, IDkgService } from "../types";
import { dkgLogger } from "./Logger";

/**
 * DKG Edge Node Service - Real DKG integration
 */
export class DkgService implements IDkgService {
  private dkgClient: any = null;

  /**
   * Initialize with MCP context (when running as plugin)
   */
  async initialize(ctx?: any) {
    if (ctx?.dkg) {
      this.dkgClient = ctx.dkg;
      dkgLogger.info("DKG Service initialized with DKG client from context");
      return;
    }

    // Fallback to standalone initialization for CLI usage
    await this.initializeStandalone();
  }

  /**
   * Initialize standalone DKG client (for CLI scripts)
   * Uses environment variables for configuration
   */
  async initializeStandalone() {
    const endpoint = process.env.MEDSY_DKG_ENDPOINT || process.env.DKG_ENDPOINT || "http://localhost:8900";
    const blockchain = process.env.MEDSY_DKG_BLOCKCHAIN || process.env.DKG_BLOCKCHAIN || "otp:20430";
    const privateKey = process.env.DKG_PUBLISH_WALLET;

    if (!privateKey) {
      throw new Error("DKG_PUBLISH_WALLET environment variable required for standalone DKG client");
    }

    try {
      const endpointUrl = new URL(endpoint);
      const defaultPort = endpointUrl.protocol === "https:" ? "443" : "8900";
      const port = endpointUrl.port || defaultPort;

      dkgLogger.info("Initializing standalone DKG client", {
        endpoint,
        blockchain,
        port
      });

      this.dkgClient = new DKG({
        endpoint: `${endpointUrl.protocol}//${endpointUrl.hostname}`,
        port,
        blockchain: {
          name: blockchain,
          privateKey: privateKey,
        },
        maxNumberOfRetries: 100,
        frequency: 2,
        contentType: "all",
      });

      dkgLogger.info("DKG Service initialized with standalone client");
    } catch (error) {
      dkgLogger.error("Failed to initialize standalone DKG client", { error });
      throw new Error(`Failed to initialize DKG client: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Publish a Knowledge Asset to the DKG
   */
  async publishKnowledgeAsset(content: any, privacy: "private" | "public" = "private"): Promise<DkgPublishResult> {
    if (!this.dkgClient) {
      throw new Error("DKG client not initialized");
    }

    dkgLogger.info("Publishing Knowledge Asset to DKG", {
      contentPreview: JSON.stringify(content).substring(0, 200) + "...",
      privacy
    });

    // Create simple JSON-LD for DKG (following working pattern from publishNote)
    const jsonLdContent = {
      "@context": "https://schema.org/",
      "@type": "MedicalWebPage",
      "@id": `urn:health-claim:${Date.now()}`,
      "name": "Health Claim Analysis",
      "description": content.claim || "AI-powered health claim analysis",
      "text": content.summary || "Evidence-based health claim verification",
      "datePublished": new Date().toISOString(),
      "publisher": {
        "@type": "Organization",
        "name": "Medsy AI"
      },
      // Custom properties (DKG may accept these)
      "claimId": content.claimId,
      "claim": content.claim,
      "agentId": content.agentId,
      "agentName": content.agentName,
      "verdict": content.verdict,
      "confidence": content.confidence,
      "sources": content.sources,
      "analysis": content.analysis
    };

    const wrappedContent = { [privacy]: jsonLdContent };

    try {
      // Use real DKG Edge Node (following working pattern from dkg-publisher)
      const result = await this.dkgClient.asset.create(wrappedContent, {
        epochsNum: DKG_CONFIG.publishing.epochsNum,
        minimumNumberOfFinalizationConfirmations: DKG_CONFIG.publishing.minimumNumberOfFinalizationConfirmations,
        minimumNumberOfNodeReplications: DKG_CONFIG.publishing.minimumNumberOfNodeReplications,
      });

      // Check for DKG API errors first
      if (result?.operation?.publish?.errorType || result?.operation?.publish?.errorMessage) {
        const errorType = result.operation.publish.errorType;
        const errorMessage = result.operation.publish.errorMessage;
        throw new Error(`DKG API Error: ${errorType} - ${errorMessage}`);
      }

      // Validate that we actually have a UAL
      if (!result.UAL) {
        throw new Error("DKG API returned success but no UAL was provided");
      }

      dkgLogger.info("Knowledge Asset published successfully", { ual: result.UAL });

      return {
        UAL: result.UAL,
        transactionHash: result.operation?.mintKnowledgeCollection?.transactionHash,
        blockNumber: result.blockNumber
      };
    } catch (error) {
      dkgLogger.error("DKG publishing failed", { error });
      throw new Error(`DKG publishing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Retrieve a Knowledge Asset from the DKG
   */
  async getKnowledgeAsset(ual: string): Promise<DkgAsset | null> {
    if (!this.dkgClient) {
      throw new Error("DKG client not initialized");
    }

    // Skip mock UALs - these don't exist on real DKG
    if (ual.startsWith('did:dkg:demo:')) {
      dkgLogger.warn("Skipping mock UAL retrieval", { ual });
      return null;
    }

    dkgLogger.info("Retrieving Knowledge Asset from DKG", { ual });

    try {
      const result = await this.dkgClient.asset.get(ual, {
        includeMetadata: true
      });

      dkgLogger.info("Knowledge Asset retrieved successfully");

      return {
        UAL: ual,
        content: result.assertion || result,
        metadata: result.metadata,
        timestamp: result.metadata?.timestamp
      };
    } catch (error) {
      dkgLogger.error("DKG retrieval failed", { error });
      return null;
    }
  }

  /**
   * Query DKG for health-related Knowledge Assets using SPARQL
   * This replaces local DB queries for discovery
   */
  async queryHealthAssets(sparqlQuery: string): Promise<any> {
    if (!this.dkgClient) {
      throw new Error("DKG client not initialized");
    }

    dkgLogger.info("Querying DKG for health assets", { queryPreview: sparqlQuery.substring(0, 100) + "..." });

    try {
      const result = await this.dkgClient.graph?.query?.(sparqlQuery, "SELECT");
      return result;
    } catch (error) {
      dkgLogger.error("DKG query failed", { error });
      return null;
    }
  }

  /**
   * Execute SPARQL query on DKG
   */
  async executeSparqlQuery(query: string): Promise<any> {
    return this.queryHealthAssets(query);
  }

  /**
   * Query the Guardian Social Graph on the OriginTrail DKG
   * Uses the euphoria REST endpoint where Guardian data is hosted
   */
  async queryGuardianSocialGraph(sparqlQuery: string): Promise<{
    success: boolean;
    data: any;
    error?: string;
  }> {
    // Guardian Social Graph is hosted on euphoria node
    const GUARDIAN_ENDPOINT = "https://euphoria.origin-trail.network/dkg-sparql-query";

    dkgLogger.info("Querying Guardian Social Graph", {
      endpoint: GUARDIAN_ENDPOINT,
      queryPreview: sparqlQuery.substring(0, 100) + "..."
    });

    try {
      const response = await fetch(GUARDIAN_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: sparqlQuery }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorText}`);
      }

      const result = await response.json();

      // Normalize possible shapes:
      // - { success, data } from http endpoint
      // - { head, results } (SPARQL JSON)
      let normalized;
      if (Array.isArray(result?.data?.data)) {
        normalized = result.data.data;
      } else if (Array.isArray(result?.data)) {
        normalized = result.data;
      } else if (Array.isArray(result?.results?.bindings)) {
        normalized = result.results.bindings.map((b: any) => ({
          post: b.post?.value,
          headline: b.headline?.value,
          description: b.description?.value,
          url: b.url?.value,
          id: b.id?.value,
          ual: b.ual?.value,
        }));
      } else {
        normalized = [];
      }

      dkgLogger.info("Guardian Social Graph query successful", {
        resultCount: Array.isArray(normalized) ? normalized.length : "N/A"
      });

      return {
        success: true,
        data: normalized
      };
    } catch (error) {
      dkgLogger.error("Guardian Social Graph query failed", { error });
      return {
        success: false,
        data: null,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  /**
   * Find health claims to fact-check from Guardian Social Graph
   * Searches for posts about vaccines, autism, health misinformation
   */
  async findHealthClaimsToFactCheck(keywords: string[] = ["autism", "vaccine", "fact-check"]): Promise<{
    success: boolean;
    posts: Array<{
      post: string;
      headline: string;
      description: string;
      url: string;
    }>;
    error?: string;
  }> {
    const filterConditions = keywords
      .map(kw => `CONTAINS(LCASE(?headline), "${kw.toLowerCase()}")`)
      .join(" || ");

    const sparqlQuery = `
      PREFIX schema: <https://schema.org/>
      SELECT ?post ?headline ?description ?url
      WHERE {
        ?post a schema:SocialMediaPosting ;
              schema:headline ?headline ;
              schema:description ?description ;
              schema:url ?url .
        FILTER(${filterConditions})
      }
      LIMIT 10
    `;

    const result = await this.queryGuardianSocialGraph(sparqlQuery);

    if (!result.success) {
      return {
        success: false,
        posts: [],
        error: result.error
      };
    }

    // Parse SPARQL results into structured format
    const posts = Array.isArray(result.data) ? result.data.map((row: any) => ({
      post: row.post?.value || row.post || "",
      headline: row.headline?.value || row.headline || "",
      description: row.description?.value || row.description || "",
      url: row.url?.value || row.url || "",
      ual: row.ual?.value || row.identifier?.value || row.ual || row.id || ""
    })) : [];

    return {
      success: true,
      posts
    };
  }

}

