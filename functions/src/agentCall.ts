import { onRequest } from "firebase-functions/v2/https";
import { ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, db } from "./config.js";
import type { ClarificationQuestion, Task, Person } from "./extract.js";

interface ExtractedEntities {
  tasks?: Task[];
  people?: Person[];
  emotionalTone?: string;
}

/**
 * Build the context string that becomes the {{agent_context}}
 * dynamic variable in the ElevenLabs agent.
 */
function buildCallContext(
  transcript: string,
  clarificationQuestions: ClarificationQuestion[],
  entities?: ExtractedEntities,
): string {
  const locationTasks = (entities?.tasks ?? []).filter((t) => t.needsLocation);
  const meetPeople = (entities?.people ?? []).filter((p) => p.wantsToMeet);
  const tone = entities?.emotionalTone ?? "clear";

  let locationBlock = "";
  if (locationTasks.length > 0) {
    locationBlock = `\n=== LOCATION-DEPENDENT TASKS (MUST ask where) ===
${locationTasks.map((t) => `- "${t.cleaned}" ${t.locationHint ? `(they mentioned: ${t.locationHint})` : "(NO location given — you MUST ask where)"}`).join("\n")}
`;
  }

  let meetingBlock = "";
  if (meetPeople.length > 0) {
    meetingBlock = `\n=== PEOPLE THEY WANT TO MEET (dig into details) ===
${meetPeople.map((p) => `- ${p.name}${p.meetingContext ? `: ${p.meetingContext}` : ""} — a prepared question covers this; use your ONE follow-up only if the answer is missing a critical detail`).join("\n")}
`;
  }

  return `
=== YOUR MISSION ===
You are the user's thinking partner. Your job on this call is to collect the key details we need to do deep research and give them a killer brief. Ask each prepared question, allow yourself AT MOST ONE follow-up per question if the answer is too vague, then move on. Keep the call tight and efficient.

=== THEIR EMOTIONAL STATE ===
They sound ${tone}. Match their energy — if overwhelmed, be calm and structured. If excited, be focused and sharp.

=== WHAT THEY SAID (their brain dump) ===
${transcript}
${locationBlock}${meetingBlock}
=== QUESTIONS TO ASK ===
Ask these questions, but DO NOT just read them robotically. Be conversational.

${clarificationQuestions.map((q, i) => `Q${i + 1}: "${q.question}" [category: ${(q as ClarificationQuestion & { category?: string }).category ?? "detail"}]`).join("\n")}

=== FOLLOW-UP RULE (STRICT) ===
You get AT MOST ONE follow-up per question. Here is the flow:
1. Ask the prepared question. Wait for the full answer.
2. If the answer is specific enough → move to the next question. No follow-up needed.
3. If the answer is vague or missing a critical detail (location, timeline, who) → ask ONE short follow-up.
4. After that single follow-up, move on NO MATTER WHAT. Accept whatever they gave you. Do NOT ask a second follow-up. Do NOT rephrase and try again.

Follow-up triggers (use ONLY when the answer is missing one of these):
- Real-world task but no WHERE → "What area should I search in?"
- Person they want to meet but no WHEN → "When are you thinking of meeting them?"
- Vague timeline → "When does that need to happen by?"
- Competing priorities with no ranking → "If only one gets done today, which one?"

=== IMPLICIT NEEDS (observe, do NOT interrogate) ===
Listen for what they clearly need but did not ask for. Note it silently.
- "Meeting the investor tomorrow" → they need prep. Note it for the brief.
- "Need to get laptop fixed" → they need service options. If no location was given, use your ONE follow-up for that question to ask where.
- "Should catch up with Sarah" → they want a meeting. If no timing, use your ONE follow-up.
Do NOT probe implicit needs beyond a single follow-up. The research layer handles the rest.

=== AFTER ALL QUESTIONS ===
Briefly summarize back what you've captured: their top priorities, the locations you'll search, the people you'll research, and the deadlines.
Then say: "Great, give me a few minutes to pull everything together. I'll send you a voice note when it's ready."
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
      const extractedEntities = sessionData?.extractedEntities as
        | ExtractedEntities
        | undefined;

      if (!transcript || !clarificationQuestions) {
        res.status(412).json({
          error: "Session is missing transcript or clarificationQuestions.",
        });
        return;
      }

      const agentContext = buildCallContext(
        transcript,
        clarificationQuestions,
        extractedEntities,
      );


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
