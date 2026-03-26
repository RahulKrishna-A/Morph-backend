import { onRequest } from "firebase-functions/v2/https";
import { db } from "./config.js";
import { buildResearchAndVM } from "./research.js";

type DynamicVars = Record<string, unknown>;

function pickIdsFromDynamicVariables(
  vars: DynamicVars | null | undefined
): { userId: string; sessionId: string } | null {
  if (!vars || typeof vars !== "object") return null;
  const userId = String(vars.userId ?? vars.user_id ?? "").trim();
  const sessionId = String(vars.sessionId ?? vars.session_id ?? "").trim();
  if (!userId || !sessionId) return null;
  return { userId, sessionId };
}

function transcriptPayloadToString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/**
 * Step 5 — Post-call webhook.
 * ElevenLabs `post_call_transcription`: type + data with
 * conversation_initiation_client_data.dynamic_variables (userId, sessionId)
 * and analysis.transcript_summary for the research + VM pipeline.
 * Legacy: { conversation_id, transcript } with session lookup by conversationId.
 */
export const sessionWebhook = onRequest(
  {
    timeoutSeconds: 540,
    memory: "1GiB",
    cors: [
      "http://localhost:3000",
      "http://localhost:3001",
      /https:\/\/(.*\.)?morphs\.life$/,
    ],
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const body = req.body as Record<string, unknown>;
    console.log("Webhook received", body);

    try {
      let userId: string;
      let sessionId: string;
      let callTextForPipeline: string;
      let sessionRef: FirebaseFirestore.DocumentReference;

      if (body.type === "post_call_transcription" && body.data) {
        const data = body.data as Record<string, unknown>;
        const client = data.conversation_initiation_client_data as
          | Record<string, unknown>
          | undefined;
        const dynamicVars = client?.dynamic_variables as DynamicVars | undefined;
        const ids = pickIdsFromDynamicVariables(dynamicVars);

        if (!ids) {
          console.warn("post_call_transcription missing userId/sessionId in dynamic_variables", {
            dynamicVars,
          });
          res.status(400).json({
            error:
              "Missing userId or sessionId in conversation_initiation_client_data.dynamic_variables",
          });
          return;
        }

        userId = ids.userId;
        sessionId = ids.sessionId;

        const analysis = data.analysis as Record<string, unknown> | undefined;
        const transcriptSummary =
          typeof analysis?.transcript_summary === "string"
            ? analysis.transcript_summary.trim()
            : "";
        const rawTranscriptStr = transcriptPayloadToString(data.transcript);

        callTextForPipeline =
          transcriptSummary ||
          rawTranscriptStr ||
          "";

        if (!callTextForPipeline) {
          res.status(400).json({
            error: "No transcript_summary or transcript in webhook data",
          });
          return;
        }

        sessionRef = db.doc(`User/${userId}/Sessions/${sessionId}`);
        const sessionSnap = await sessionRef.get();

        if (!sessionSnap.exists) {
          console.warn("Session not found", { userId, sessionId });
          res.status(404).json({ error: "Session not found" });
          return;
        }

        const sessionData = sessionSnap.data()!;

        await sessionRef.update({
          callTranscript: callTextForPipeline,
          ...(rawTranscriptStr && rawTranscriptStr !== callTextForPipeline
            ? { callTranscriptRaw: rawTranscriptStr }
            : {}),
          status: "processing_research",
        });

        await buildResearchAndVM(sessionId, { ...sessionData, userId }, callTextForPipeline);

        res.json({ success: true });
        return;
      }

      // Legacy: conversation_id + transcript, find session by stored conversationId
      const conversation_id = body.conversation_id as string | undefined;
      const transcript = body.transcript;

      if (!conversation_id) {
        res.status(400).json({ error: "Missing conversation_id or unsupported payload" });
        return;
      }

      console.log("Webhook received (legacy)", { conversation_id });

      const usersSnap = await db.collection("User").get();
      let sessionDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
      let legacyUserId = "";

      for (const userDoc of usersSnap.docs) {
        const sessionsSnap = await userDoc.ref
          .collection("Sessions")
          .where("conversationId", "==", conversation_id)
          .limit(1)
          .get();

        if (!sessionsSnap.empty) {
          sessionDoc = sessionsSnap.docs[0];
          legacyUserId = userDoc.id;
          break;
        }
      }

      if (!sessionDoc) {
        console.warn("Session not found for conversation", { conversation_id });
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const transcriptStr =
        typeof transcript === "string"
          ? transcript
          : transcriptPayloadToString(transcript) ?? "";

      const sessionData = sessionDoc.data();

      await sessionDoc.ref.update({
        callTranscript: transcriptStr,
        status: "processing_research",
      });

      await buildResearchAndVM(
        sessionDoc.id,
        { ...sessionData, userId: legacyUserId },
        transcriptStr
      );

      res.json({ success: true });
    } catch (error) {
      console.error("Webhook processing failed", { error });
      res.status(500).json({
        error: error instanceof Error ? error.message : "Internal error",
      });
    }
  }
);
