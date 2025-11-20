import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DkgContext } from "@dkg/plugins";
import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { PublishNoteSchema, IDkgService } from "../types";
import { communityNotes, healthClaims } from "../database";
import * as schema from "../database/schema";
import { createServiceLogger } from "../services/Logger";

const logger = createServiceLogger("PublishNoteTool");

function buildCommunityNoteJsonLd(params: {
  noteId: string;
  claimId: string;
  summary: string;
  confidence: number;
  verdict: string;
  sources: string[];
  annotates?: {
    id: string;
    ual?: string;
    headline?: string;
    platform?: string;
  };
}) {
  const { noteId, claimId, summary, confidence, verdict, sources, annotates } = params;
  const timestamp = new Date().toISOString();
  const noteUri = `urn:medsy:note:${noteId}`;

  const yourAsset = {
    "@type": "schema:ClaimReview",
    "@id": noteUri,

    "schema:name": `Health Fact-Check: ${verdict.toUpperCase()}`,
    "schema:reviewBody": summary,
    "schema:datePublished": timestamp,

    "schema:reviewRating": {
      "@type": "schema:Rating",
      "schema:ratingValue": confidence,
      "schema:ratingExplanation": `${verdict} (${(confidence * 100).toFixed(0)}% confidence)`
    },

    "schema:author": {
      "@type": "schema:Organization",
      "schema:name": "Medsy AI"
    }
  };

  if (annotates) {
    yourAsset["schema:itemReviewed"] = {
      "@type": "schema:SocialMediaPosting",
      "@id": annotates.id,
      "schema:headline": annotates.headline || "Social media post",
      "schema:genre": annotates.platform || "social"
    };
  }

  if (sources && sources.length > 0) {
    yourAsset["schema:citation"] = sources.map(url => ({
      "@type": "schema:WebPage",
      "schema:url": url
    }));
  }

  if (annotates) {
    yourAsset["prov:wasDerivedFrom"] = annotates.id;
  }

  return {
    "@context": "https://schema.org/",
    "@graph": [yourAsset]
  };
}

export function registerPublishNoteTool(
  mcp: McpServer,
  ctx: DkgContext,
  dkgService: IDkgService,
  db: BetterSQLite3Database<typeof schema>
) {
  mcp.registerTool(
    "publish-health-note",
    {
      title: "Publish Health Community Note",
      description: "Publish a verified health claim analysis as a Community Note on the DKG. When fact-checking content from the Guardian Social Graph, include the 'annotates' parameter to link the note to the original asset.",
      inputSchema: PublishNoteSchema.shape
    },
    async ({ claimId, summary, confidence, verdict, sources, annotates }) => {
      try {
        logger.info("Publishing health community note", {
          claimId,
          verdict,
          confidence,
          hasAnnotation: !!annotates
        });

        const noteId = `note_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const noteContent = buildCommunityNoteJsonLd({
          noteId,
          claimId,
          summary,
          confidence,
          verdict,
          sources,
          annotates
        });

        logger.info("JSON-LD Knowledge Asset structure", {
          context: Object.keys(noteContent["@context"]),
          graphEntities: noteContent["@graph"].length,
          annotates: annotates?.id || "none"
        });

        const result = await dkgService.publishKnowledgeAsset(noteContent, "public");

        await db.insert(communityNotes).values({
          noteId,
          claimId,
          ual: result.UAL,
          summary,
          confidence,
          verdict,
          sources: JSON.stringify(sources),
          createdAt: new Date(),
          updatedAt: new Date(),
        });

        await db.update(healthClaims)
          .set({ status: "published", updatedAt: new Date() })
          .where(eq(healthClaims.claimId, claimId));

        logger.info("Community note published successfully", {
          noteId,
          ual: result.UAL,
          claimId,
          annotates: annotates?.id
        });

        let responseText = `Community Note published successfully!\n\n`;
        responseText += `📋 **Note Details**\n`;
        responseText += `• UAL: ${result.UAL}\n`;
        responseText += `• Note ID: ${noteId}\n`;
        responseText += `• Verdict: ${verdict.toUpperCase()}\n`;
        responseText += `• Confidence: ${(confidence * 100).toFixed(1)}%\n\n`;

        if (annotates) {
          responseText += `🔗 **Linked to Guardian Social Graph**\n`;
          responseText += `• Original: ${annotates.id}\n`;
          if (annotates.ual) {
            responseText += `• Guardian UAL: ${annotates.ual}\n`;
          }
          if (annotates.headline) {
            responseText += `• Headline: ${annotates.headline}\n`;
          }
          responseText += `\n`;
        }

        responseText += `🌐 **View on DKG:** https://dkg-testnet.origintrail.io/explore?ual=${encodeURIComponent(result.UAL)}\n\n`;
        responseText += `💎 **Premium Access Available**: Pay TRAC for enhanced analysis with expert commentary, medical citations, and comprehensive assessment.`;

        return {
          content: [{
            type: "text",
            text: responseText
          }],
          noteId,
          ual: result.UAL,
          jsonLd: noteContent
        };
      } catch (error: any) {
        logger.error("Publishing note failed", { error: error.message, claimId });
        return {
          content: [{ type: "text", text: `Failed to publish note: ${error.message || "Please try again."}` }],
          isError: true
        };
      }
    }
  );
}
