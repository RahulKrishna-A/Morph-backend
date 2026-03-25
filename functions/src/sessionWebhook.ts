import { onRequest } from "firebase-functions/v2/https";
import { db } from "./config.js";
import { buildResearchAndVM } from "./research.js";

/**
 * Step 5 — Post-call webhook.
 * ElevenLabs POSTs here when the agent call ends.
 * Payload contains { conversation_id, transcript }.
 */
export const sessionWebhook = onRequest(
  {
    timeoutSeconds: 540,
    memory: "1GiB",
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { conversation_id, transcript } = req.body;

    if (!conversation_id) {
      res.status(400).json({ error: "Missing conversation_id" });
      return;
    }

    console.log("Webhook received", { conversation_id });

    try {
      // Find the session by conversationId — search across all users
      const usersSnap = await db.collection("User").get();
      let sessionDoc: FirebaseFirestore.QueryDocumentSnapshot | null = null;
      let userId = "";

      for (const userDoc of usersSnap.docs) {
        const sessionsSnap = await userDoc.ref
          .collection("Sessions")
          .where("conversationId", "==", conversation_id)
          .limit(1)
          .get();

        if (!sessionsSnap.empty) {
          sessionDoc = sessionsSnap.docs[0];
          userId = userDoc.id;
          break;
        }
      }

      if (!sessionDoc) {
        console.warn("Session not found for conversation", { conversation_id });
        res.status(404).json({ error: "Session not found" });
        return;
      }

      const sessionData = sessionDoc.data();

      // Save call transcript and update status
      await sessionDoc.ref.update({
        callTranscript: transcript,
        status: "processing_research",
      });

      // Trigger the research + VM build pipeline
      await buildResearchAndVM(
        sessionDoc.id,
        { ...sessionData, userId },
        transcript
      );

      res.json({ success: true });
    } catch (error) {
      console.error("Webhook processing failed", { conversation_id, error });
      res.status(500).json({
        error: error instanceof Error ? error.message : "Internal error",
      });
    }
  }
);
