import { onRequest } from "firebase-functions/v2/https";
import { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, db } from "./config.js";
import type { ClarificationQuestion } from "./extract.js";

/**
 * Build the context string that becomes the {{agent_context}}
 * dynamic variable in the ElevenLabs agent.
 */
function buildCallContext(
  transcript: string,
  clarificationQuestions: ClarificationQuestion[],
): string {
  return `
=== WHAT THEY SAID (their morning dump) ===
${transcript}

=== QUESTIONS TO ASK (in this exact order) ===
${clarificationQuestions.map((q, i) => `Q${i + 1}: "${q.question}"`).join("\n")}

=== AFTER ALL QUESTIONS ===
Say: "Perfect, give me a few minutes to pull everything together. 
I'll send you a voice note when it's ready."
Then end the call.
`;
}

/**
 * Creates a conversation via ElevenLabs Conversational AI API.
 * POST JSON body: { sessionId, userId }.
 */
export const onAgentCall = onRequest(
  {
    timeoutSeconds: 60,
    memory: "256MiB",
    cors: true,
  },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const { sessionId, userId } = req.body ?? {};

    if (!sessionId || !userId) {
      res.status(400).json({
        error:
          "The function must be called with 'sessionId' and 'userId' in the JSON body.",
      });
      return;
    }

    console.log("Initiating agent call via HTTP", { sessionId, userId });

    const sessionRef = db.doc(`User/${userId}/Sessions/${sessionId}`);

    try {
      const sessionSnap = await sessionRef.get();
      if (!sessionSnap.exists) {
        res.status(404).json({ error: "Session not found." });
        return;
      }

      const sessionData = sessionSnap.data();
      const transcript = sessionData?.transcript as string | undefined;
      const clarificationQuestions = sessionData?.clarificationQuestions as
        | ClarificationQuestion[]
        | undefined;

      if (!transcript || !clarificationQuestions) {
        res.status(412).json({
          error: "Session is missing transcript or clarificationQuestions.",
        });
        return;
      }

      const agentContext = buildCallContext(transcript, clarificationQuestions);


      const apiRes = await fetch(
        `https://api.elevenlabs.io/v1/convai/conversation/token?agent_id=${ELEVENLABS_AGENT_ID}`,
        {
          headers: {
            // Requesting a signed url requires your ElevenLabs API key
            // Do NOT expose your API key to the client!
            "xi-api-key": ELEVENLABS_API_KEY,
          },
        },
      );

      if (!apiRes.ok) {
        const errText = await apiRes.text();
        throw new Error(
          `ElevenLabs create conversation failed (${apiRes.status}): ${errText}`,
        );
      }

      const data = (await apiRes.json()) as { token: string };

      await sessionRef.update({
        conversationToken: data.token,
        status: "call_in_progress",
      });

      console.log("Agent call initiated", {
        sessionId,
        conversationToken: data.token,
      });

      res.json({ conversationToken: data.token, agentContext });
    } catch (error) {
      console.error("Agent call failed", { sessionId, error });

      await sessionRef
        .update({
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        })
        .catch((updateErr) => {
          console.error("Failed to update session with error state", {
            sessionId,
            updateErr,
          });
        });

      res.status(500).json({
        error:
          error instanceof Error ? error.message : "Internal error occurred",
      });
    }
  },
);
