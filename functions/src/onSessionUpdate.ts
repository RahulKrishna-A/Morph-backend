import {
  type FirestoreEvent,
  onDocumentCreated,
  type QueryDocumentSnapshot,
} from "firebase-functions/v2/firestore";
import "./config.js";
import { transcribeAudio } from "./transcribe.js";
import { extractAndGenerateQuestions } from "./extract.js";

const SESSION_DOCUMENT = "User/{userId}/Sessions/{sessionId}" as const;

type SessionCreateEvent = FirestoreEvent<
  QueryDocumentSnapshot | undefined,
  { userId: string; sessionId: string }
>;

/**
 * Step 1 — Firestore trigger on session document creation.
 * Watches User/{userId}/Sessions/{sessionId}.
 * When the created document includes `dumpAudioUrl` (a Firebase Storage audio URL),
 * kicks off transcription + extraction.
 */
export const onSessionUpdate = onDocumentCreated(
  {
    document: SESSION_DOCUMENT,
    timeoutSeconds: 300,
    memory: "1GiB",
  },
  async (event: SessionCreateEvent) => {
    const snap = event.data;
    if (!snap) return;

    const data = snap.data();
    const hasDump = !!data.dumpAudioUrl;
    if (!hasDump) {
      console.log("No dump on create");
      return;
    }

    const dumpUrl = data.dumpAudioUrl as string;
    const sessionRef = snap.ref;
    const sessionId = event.params.sessionId;

    console.log("Dump detected on create, starting pipeline", {
      sessionId,
      dumpUrl,
    });

    try {
      // Update status
      await sessionRef.update({ status: "transcribing" });

      // Step 2a: Transcribe
      const transcript = await transcribeAudio(dumpUrl);

      // Step 2b: Extract entities + generate questions
      const extraction = await extractAndGenerateQuestions(transcript);

      // Save results — status triggers the agent call function
      await sessionRef.update({
        transcript,
        extractedEntities: {
          tasks: extraction.tasks,
          people: extraction.people,
          researchTopics: extraction.researchTopics,
          emotionalTone: extraction.emotionalTone,
        },
        clarificationQuestions: [
          ...extraction.clarificationQuestions,
          // Append the priority question as the last question
          {
            id: `q${extraction.clarificationQuestions.length + 1}`,
            question: extraction.priorityQuestion,
            targetId: "priority",
            why: "Determines task ordering for the day",
          },
        ],
        status: "ready_for_call",
      });

      console.log("Pipeline step 2 complete — ready for agent call", {
        sessionId,
      });
    } catch (error) {
      console.error("Pipeline failed", { sessionId, error });
      await sessionRef.update({
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
);
