import {
  db,
  storage,
  openai,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
} from "./config.js";

// --- Types ---

interface VoiceMessageData {
  dumpTranscript: string;
  answers: Array<{
    questionId: string;
    question: string;
    answer: string;
  }>;
  priorityOrder: string[];
  additionalContext: string;
  firecrawlResults: Record<
    string,
    Array<{ title: string; url: string; content: string }>
  >;
  entities: {
    tasks: Array<{ cleaned: string }>;
    people: Array<{ name: string }>;
    researchTopics: Array<{ topic: string }>;
    emotionalTone: string;
  };
}

/**
 * Step 7 — Build the spoken voice message script via GPT-4o,
 * then hand off to TTS.
 */
export async function buildVoiceMessage(
  sessionId: string,
  userId: string,
  data: VoiceMessageData
): Promise<void> {
  const {
    dumpTranscript,
    answers,
    priorityOrder,
    additionalContext,
    firecrawlResults,
    entities: _entities,
  } = data;

  console.log("Building voice message script", { sessionId });



  const scriptRes = await openai.chat.completions.create({
    model: "gpt-5.1",
    messages: [
      {
        role: "system",
        content: `
          You are writing a spoken voice note script. 
          This will be converted directly to audio by a TTS engine.
          
          Write it as natural spoken words — NOT bullet points, 
          NOT headers, NOT markdown. 
          
          Structure (in this order):
          1. Quick open (one sentence, no fluff)
          2. Top 3 priorities for today — spoken naturally, not listed
          3. Research findings — ONE useful thing per topic, 
             name the source casually ("I checked..." / "Saw something interesting...")
          4. Quick close — 1 sentence, end cleanly
          
          RULES:
          - Max 250 words total — this is a voice note, not a report
          - No "Great news!" or filler openers
          - Sound like a person, not an AI
          - If a search found nothing useful, skip it entirely
          - Speak priorities in order of what was confirmed in the call
          - Do not say "According to my research" — just say what you found
        `,
      },
      {
        role: "user",
        content: `
          Original dump: "${dumpTranscript}"
          
          Priority order confirmed in call: ${JSON.stringify(priorityOrder)}
          
          Answers from clarification call: ${JSON.stringify(answers)}
          
          Research found: ${JSON.stringify(firecrawlResults)}
          
          Additional context from call: ${additionalContext}
        `,
      },
    ],
  });

  const vmScript = scriptRes.choices[0].message.content;
  if (!vmScript) {
    throw new Error("GPT-4o returned empty VM script");
  }

  console.log("VM script generated", {
    sessionId,
    wordCount: vmScript.split(/\s+/).length,
  });

  // Step 8: Convert to audio
  await generateVoiceMessage(sessionId, userId, vmScript);
}

/**
 * Step 8 — Convert the script to audio via ElevenLabs TTS,
 * upload to Firebase Storage, and update the session.
 */
async function generateVoiceMessage(
  sessionId: string,
  userId: string,
  script: string
): Promise<void> {
  const voiceId = ELEVENLABS_VOICE_ID;

  console.log("Generating TTS audio", { sessionId, voiceId });

  const ttsRes = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text: script,
        model_id: "eleven_turbo_v2_5",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          speed: 1.0,
        },
      }),
    }
  );

  if (!ttsRes.ok) {
    const errText = await ttsRes.text();
    throw new Error(`TTS failed (${ttsRes.status}): ${errText}`);
  }

  // Get audio as buffer
  const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());

  // Upload to Firebase Storage
  const bucket = storage.bucket();
  const vmPath = `voicemessages/${sessionId}/brief.mp3`;
  await bucket.file(vmPath).save(audioBuffer, {
    metadata: { contentType: "audio/mpeg" },
  });

  // Get signed URL (7 days)
  const [url] = await bucket.file(vmPath).getSignedUrl({
    action: "read",
    expires: Date.now() + 7 * 24 * 60 * 60 * 1000,
  });

  // Save everything to Firestore — status: complete triggers the frontend
  const sessionRef = db
    .collection("User")
    .doc(userId)
    .collection("Sessions")
    .doc(sessionId);

  await sessionRef.update({
    vmUrl: url,
    vmScript: script,
    status: "complete",
    completedAt: new Date(),
  });

  console.log("Voice message complete", { sessionId, vmPath });
}
