import { ComponentProps, useCallback, useState, useRef, useEffect } from "react";
import {
  View,
  TextInput,
  StyleProp,
  ViewStyle,
  StyleSheet,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  withSpring,
  interpolate,
  Extrapolation,
  Easing,
} from "react-native-reanimated";
import * as DocumentPicker from "expo-document-picker";

import Button from "@/components/Button";
import Popover from "@/components/Popover";
import ArrowUpIcon from "@/components/icons/ArrowUpIcon";
import MicrophoneIcon from "@/components/icons/MicrophoneIcon";
import AttachFileIcon from "@/components/icons/AttachFileIcon";
import ToolsIcon from "@/components/icons/ToolsIcon";
import useColors from "@/hooks/useColors";
import usePlatform from "@/hooks/usePlatform";
import { ChatMessage, toContents } from "@/shared/chat";
import { toError } from "@/shared/errors";
import { FileDefinition } from "@/shared/files";

import ChatInputFilesSelected from "./Input/FilesSelected";
import ChatInputToolsSelector from "./Input/ToolsSelector";
import ChatInputAttachmentChip from "./Input/AttachmentChip";
import { useMcpClient } from "@/client";

export default function ChatInput({
  onSendMessage,
  onUploadFiles = (assets) =>
    assets.map((a) => ({
      id: a.uri,
      uri: a.uri,
      name: a.name,
      mimeType: a.mimeType,
    })),
  onUploadError,
  onAttachFiles = (files) =>
    files.map((f) => ({
      type: "file",
      file: {
        filename: f.name,
        file_data: f.uri,
      },
    })),
  onFileRemoved,
  authToken,
  tools = {},
  onToolTick,
  onToolServerTick,
  disabled,
  style,
}: {
  onSendMessage: (message: ChatMessage) => void;
  onUploadFiles?: (
    files: DocumentPicker.DocumentPickerAsset[],
  ) => FileDefinition[] | Promise<FileDefinition[]>;
  onUploadError?: (error: Error) => void;
  onAttachFiles?: (files: FileDefinition[]) => ChatMessage["content"];
  onFileRemoved?: (file: FileDefinition) => void;
  /* Required for previewing uploaded images */
  authToken?: string;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
} & ComponentProps<typeof ChatInputToolsSelector>) {
  const colors = useColors();
  const { isWeb } = usePlatform();
  const [message, setMessage] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<FileDefinition[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const inputRef = useRef<any>(null);
  const mcp = useMcpClient();

  // Animation states
  const focusValue = useSharedValue(0);
  const hoverValue = useSharedValue(0);
  const typingValue = useSharedValue(0);

  // Animated styles
  const inputContainerStyle = useAnimatedStyle(() => ({
    transform: [
      {
        scale: interpolate(
          focusValue.value,
          [0, 1],
          [1, 1.02],
          Extrapolation.CLAMP
        ),
      },
    ],
    shadowColor: colors.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: interpolate(
      focusValue.value + hoverValue.value,
      [0, 2],
      [0, 0.25],
      Extrapolation.CLAMP
    ),
    shadowRadius: interpolate(
      focusValue.value + hoverValue.value,
      [0, 2],
      [0, 12],
      Extrapolation.CLAMP
    ),
    elevation: interpolate(
      focusValue.value + hoverValue.value,
      [0, 2],
      [0, 6],
      Extrapolation.CLAMP
    ),
  }));

  const inputStyle = useAnimatedStyle(() => ({
    borderWidth: 2,
    borderColor: colors.primary,
    backgroundColor: focusValue.value > 0 ? 'rgba(255, 153, 153, 0.12)' : 'rgba(255, 153, 153, 0.08)',
  }));

  useEffect(() => {
    if (isWeb && inputRef.current) {
      const inputElement = (inputRef.current as any)._nativeTag ||
        (inputRef.current as any).getNativeScrollRef?.() ||
        inputRef.current;

      if (inputElement && typeof document !== 'undefined') {
        setTimeout(() => {
          // Find the actual input element in the DOM
          const domElement = document.querySelector('input') as HTMLInputElement;
          if (domElement) {
            domElement.style.setProperty('background-color', 'rgba(255, 153, 153, 0.08)', 'important');
            domElement.style.setProperty('-webkit-appearance', 'none', 'important');
            domElement.style.setProperty('-moz-appearance', 'textfield', 'important');
            domElement.style.setProperty('appearance', 'none', 'important');
            domElement.style.setProperty('border', '2px solid #FF9999', 'important');
            domElement.style.setProperty('box-shadow', 'none', 'important');
            domElement.style.setProperty('outline', 'none', 'important');

            const handleFocus = () => {
              domElement.style.setProperty('background-color', 'rgba(255, 153, 153, 0.12)', 'important');
            };
            const handleBlur = () => {
              domElement.style.setProperty('background-color', 'rgba(255, 153, 153, 0.08)', 'important');
            };

            domElement.addEventListener('focus', handleFocus);
            domElement.addEventListener('blur', handleBlur);

            const existingStyle = document.getElementById('medsy-input-styles');
            if (!existingStyle) {
              const style = document.createElement('style');
              style.id = 'medsy-input-styles';
              style.textContent = `
                input {
                  background-color: rgba(255, 153, 153, 0.08) !important;
                  -webkit-appearance: none !important;
                  -moz-appearance: textfield !important;
                  appearance: none !important;
                  border: 2px solid #FF9999 !important;
                  box-shadow: none !important;
                  outline: none !important;
                }
                input:focus {
                  background-color: rgba(255, 153, 153, 0.12) !important;
                }
                input::selection {
                  background-color: rgba(255, 153, 153, 0.3) !important;
                }
              `;
              document.head.appendChild(style);
            }
          }
        }, 100);
      }
    }
  }, [isWeb]);

  const onSubmit = useCallback(() => {
    onSendMessage({
      role: "user",
      content: [
        ...toContents(selectedFiles.length ? onAttachFiles(selectedFiles) : []),
        { type: "text", text: message.trim() },
      ],
    });
    setMessage("");
    setSelectedFiles([]);
  }, [message, selectedFiles, onSendMessage, onAttachFiles]);

  // Build topic-specific SPARQL queries for the Guardian Social Graph
  const buildVaccineQuery = () => `PREFIX schema: <https://schema.org/>

SELECT ?post ?headline ?url
WHERE {
  ?post a schema:SocialMediaPosting ;
        schema:headline ?headline ;
        schema:url ?url .

  FILTER(
    CONTAINS(LCASE(?headline), "vaccine") ||
    CONTAINS(LCASE(?headline), "vaccination") ||
    CONTAINS(LCASE(?headline), "immunization")
  )
}
LIMIT 30`;

  const buildNaturalRemedyQuery = () => `PREFIX schema: <https://schema.org/>

SELECT ?post ?headline ?url
WHERE {
  ?post a schema:SocialMediaPosting ;
        schema:headline ?headline ;
        schema:url ?url .

  FILTER(
    CONTAINS(LCASE(?headline), "natural remedy") ||
    CONTAINS(LCASE(?headline), "herbal") ||
    CONTAINS(LCASE(?headline), "holistic") ||
    CONTAINS(LCASE(?headline), "alternative medicine") ||
    CONTAINS(LCASE(?headline), "natural cure") ||
    CONTAINS(LCASE(?headline), "home remedy")
  )
}
LIMIT 30`;

  const buildScientificPaperQuery = () => `PREFIX schema: <https://schema.org/>

SELECT ?post ?headline ?url
WHERE {
  ?post a schema:SocialMediaPosting ;
        schema:headline ?headline ;
        schema:url ?url .

  FILTER(
    CONTAINS(LCASE(?headline), "research") ||
    CONTAINS(LCASE(?headline), "study") ||
    CONTAINS(LCASE(?headline), "scientific") ||
    CONTAINS(LCASE(?headline), "paper") ||
    CONTAINS(LCASE(?headline), "journal")
  )
}
LIMIT 30`;

  const runQuickQuery = useCallback(
    async (topicLabel: string, queryBuilder: () => string, fallbackText: string) => {
      // If MCP is not available, fall back to plain text prompt
      if (!mcp?.token) {
        onSendMessage({
          role: "user",
          content: [{ type: "text", text: fallbackText }],
        });
        return;
      }

      try {
        // Call the DKG query tool with the topic-specific SPARQL query
        const sparqlQuery = queryBuilder();

        const toolResult = await mcp.callTool(
          {
            name: "query-knowledge-graph",
            arguments: { query: sparqlQuery },
          },
          undefined,
          { timeout: 120000, maxTotalTimeout: 120000 },
        );

        // Parse SPARQL results from the Guardian Social Graph
        let rows: any[] = [];
        const rawText = Array.isArray(toolResult.content)
          ? toolResult.content.find((c: any) => c?.type === "text")?.text
          : (toolResult as any)?.content || (toolResult as any)?.text;

        if (typeof rawText === "string") {
          try {
            const parsed = JSON.parse(rawText);
            const dataRows = parsed?.data?.data;
            if (Array.isArray(dataRows)) rows = dataRows;
          } catch (err) {
            console.debug("Failed to parse tool result:", err);
          }
        }

        const DKG_EXPLORER_BASE = "https://dkg-testnet.origintrail.io/explore?ual=";
        const limited = rows.slice(0, 10);
        const formatted =
          limited.length === 0
            ? `No ${topicLabel} posts found in the Guardian Social Graph. Try a different topic or check back later.`
            : limited
                .map((r, i) => {
                  const headline = r.headline || r.title || "Untitled";
                  const contentUrl = r.url || "N/A";
                  const ual = r.post || r["@id"] || r.id || r.ual;

                  // Simple format: Number. "Headline" — URL — UAL (for blockchain verification)
                  let result = `${i + 1}. "${headline}"\n   🔗 ${contentUrl}`;

                  if (ual) {
                    const explorerUrl = `${DKG_EXPLORER_BASE}${encodeURIComponent(ual)}`;
                    result += `\n   🔍 Verify: ${explorerUrl}`;
                  }

                  return result;
                })
                .join("\n\n");

        onSendMessage({
          role: "assistant",
          content: [
            {
              type: "text",
              text: `**Latest ${topicLabel} from the Guardian Social Graph** (queried via DKG blockchain)\n\n${formatted}\n\n💡 *Each result includes a UAL (Universal Asset Locator) that you can verify on the OriginTrail DKG blockchain explorer.*\n\nAsk me to analyze a specific post by number, or request more details about any claim.`,
            },
          ],
        });
      } catch (error) {
        console.error("Quick query failed:", error);
        onSendMessage({
          role: "user",
          content: [{ type: "text", text: fallbackText }],
        });
      }
    },
    [mcp, onSendMessage],
  );

  return (
    <View style={[{ width: "100%", position: "relative" }, style]}>
      {!!selectedFiles.length && (
        <ChatInputFilesSelected
          selectedFiles={selectedFiles}
          authToken={authToken}
          onRemove={(removedFile) => {
            setSelectedFiles((files) =>
              files.filter((f) => f.id !== removedFile.id),
            );
            onFileRemoved?.(removedFile);
          }}
        />
      )}
      <Animated.View style={[styles.inputContainer, inputContainerStyle]}>
        <TextInput
          ref={inputRef}
          style={[
            styles.input,
            inputStyle,
            { color: colors.text },
          ]}
          placeholder="Ask anything..."
          placeholderTextColor="rgba(255, 153, 153, 0.6)"
          onChangeText={(text: string) => {
            setMessage(text);
            typingValue.value = withSpring(text.length > 0 ? 1 : 0, {
              damping: 15,
              stiffness: 100,
            });
          }}
          value={message}
          multiline={false}
          testID="chat-input"
          onFocus={() => {
            focusValue.value = withSpring(1, {
              damping: 20,
              stiffness: 200,
            });
          }}
          onBlur={() => {
            focusValue.value = withSpring(0, {
              damping: 20,
              stiffness: 200,
            });
          }}
          onKeyPress={({ nativeEvent }: any) => {
            if (nativeEvent.key === "Enter") {
              // Submit on Enter key press
              if (message.trim() && !disabled) {
                onSubmit();
              }
            }
          }}
        />
        <View style={styles.inputButtons}>
          <Button
            color="secondary"
            flat
            icon={MicrophoneIcon}
            iconMode="fill"
            style={styles.inputButton}
            disabled={disabled}
          />
          <Button
            color="primary"
            icon={ArrowUpIcon}
            style={styles.inputButton}
            disabled={!message.trim() || disabled || isUploading}
            onPress={onSubmit}
            testID="chat-send-button"
          />
        </View>
      </Animated.View>

      {/* Custom Query Buttons */}
      <View style={styles.quickQueryButtons}>
        <Button
          color="secondary"
          flat
          text="🦠 Vaccine Posts"
          style={styles.quickQueryButton}
          disabled={disabled}
          onPress={async () => {
            runQuickQuery(
              "vaccine posts",
              buildVaccineQuery,
              "Find social media posts about vaccines from the Guardian Social Graph on DKG",
            );
          }}
        />
        <Button
          color="secondary"
          flat
          text="🌿 Natural Remedies"
          style={styles.quickQueryButton}
          disabled={disabled}
          onPress={async () => {
            runQuickQuery(
              "natural remedy posts",
              buildNaturalRemedyQuery,
              "Find social media posts about natural remedies from the Guardian Social Graph on DKG",
            );
          }}
        />
        <Button
          color="secondary"
          flat
          text="📄 Scientific Papers"
          style={styles.quickQueryButton}
          disabled={disabled}
          onPress={async () => {
            runQuickQuery(
              "scientific research posts",
              buildScientificPaperQuery,
              "Find posts about scientific research and studies from the Guardian Social Graph on DKG",
            );
          }}
        />
      </View>

      {/* Tools section */}
      <View style={styles.inputTools}>
        <Button
          disabled={disabled || isUploading}
          color="secondary"
          flat
          icon={AttachFileIcon}
          text="Attach file(s)"
          style={{ height: "100%" }}
          testID="chat-attach-file-button"
          onPress={() => {
            setIsUploading(true);
            DocumentPicker.getDocumentAsync({ base64: true, multiple: true })
              .then((r) => (r.assets ? onUploadFiles(r.assets) : []))
              .then((files) =>
                setSelectedFiles((prev) => [
                  ...new Set([...prev, ...files]),
                ])
              )
              .catch((err) => onUploadError?.(toError(err)))
              .finally(() => setIsUploading(false));
          }}
        />
        <Popover
          from={(open, toggle) => (
            <Button
              color="secondary"
              flat
              icon={ToolsIcon}
              style={{
                height: "100%",
                aspectRatio: 1,
                backgroundColor: open ? colors.card : "transparent",
              }}
              onPress={() => toggle((v) => !v)}
            />
          )}
        >
          <ChatInputToolsSelector
            tools={tools}
            onToolTick={onToolTick}
            onToolServerTick={onToolServerTick}
          />
        </Popover>
      </View>
    </View>
  );
}

// Styles
const styles = StyleSheet.create({
  inputContainer: {
    position: "relative",
    height: 56,
    width: "100%",
    borderRadius: 50,
  },
  input: {
    borderRadius: 50,
    paddingHorizontal: 20,
    paddingVertical: 16,
    height: 56,
    fontSize: 16,
    lineHeight: 24,
  },
  inputButtons: {
    position: "absolute",
    right: 0,
    padding: 4,
    gap: 4,
    flexDirection: "row",
    height: "100%",
  },
  inputButton: {
    height: "100%",
    aspectRatio: 1,
  },
  quickQueryButtons: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    marginTop: 12,
    marginBottom: 4,
    paddingHorizontal: 8,
    flexWrap: "wrap",
  },
  quickQueryButton: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    height: 36,
  },
  inputTools: {
    position: "relative",
    width: "100%",
    height: 40,
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginVertical: 8,
    paddingHorizontal: 8,
  },
});

ChatInput.FilesSelected = ChatInputFilesSelected;
ChatInput.ToolsSelector = ChatInputToolsSelector;
ChatInput.AttachmentChip = ChatInputAttachmentChip;
