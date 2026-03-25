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
  callSummary: string;
  priorities: string[];
  additionalContext: string;
  researchPlan: Array<{ key: string; query: string }>;
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

function sourceLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "source";
  }
}

function buildResearchContextBlock(
  researchPlan: Array<{ key: string; query: string }>,
  firecrawlResults: Record<string, Array<{ title: string; url: string; content: string }>>
): string {
  if (researchPlan.length === 0) {
    return "No external lookup was required for this session.";
  }

  const sections = researchPlan.map((item) => {
    const rows = (firecrawlResults[item.key] ?? []).slice(0, 3);
    if (rows.length === 0) {
      return `Query: ${item.query}\nNo strong external signal found.`;
    }

    const sourceLines = rows.map((row, index) => {
      const excerpt = row.content.slice(0, 900);
      return `${index + 1}. ${row.title} (${sourceLabel(row.url)})\n${excerpt}`;
    });

    return `Query: ${item.query}\n${sourceLines.join("\n\n")}`;
  });

  return sections.join("\n\n---\n\n");
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
    callSummary,
    priorities,
    additionalContext,
    researchPlan,
    firecrawlResults,
    entities,
  } = data;

  console.log("Building voice message script", { sessionId });

  const scriptRes = await openai.chat.completions.create({
    model: "gpt-5.1",
    messages: [
      {
        role: "system",
        content: `You are writing a personalized spoken daily brief that will be converted directly into TTS audio.
Your goal is to give the user clarity, focus, and momentum in under about 90 seconds.

Output format requirements:
- Return plain text only.
- No markdown, no bullets, no numbered lists, no headings, no emojis.
- Write natural spoken prose suitable for text-to-speech.

Required structure and order:
1. One-sentence opening that orients the user to today.
2. Priority guidance: walk through priorities in the exact provided order, naturally in speech.
3. Research insights: include only high-signal findings tied to current priorities.
4. One-sentence close that prompts immediate action.

Voice and style rules:
- Sound like a trusted chief of staff: calm, direct, practical, encouraging.
- Use conversational language and contractions when natural.
- Avoid hype, filler, and generic motivational lines.
- Do not mention being an AI or doing "research" in abstract terms.

Content rules:
- Respect the user's emotional context without sounding dramatic.
- For each priority, include a concrete next step, decision point, or sequencing cue.
- Use only facts present in provided search results. Never invent facts, names, numbers, dates, or claims.
- Weave specific details from research findings directly into the brief: names, prices, ratings, locations, hours, comparisons, and other concrete data points the user needs.
- Mention sources casually when used (for example publication/site names), but never read full URLs.
- If a result is weak or ambiguous, phrase it with appropriate uncertainty.
- Skip search items that contain no useful signal.
- If there are no meaningful findings, briefly acknowledge that and continue with actionable guidance.
- When research provides multiple options (restaurants, services, products), highlight the top 2-3 with their distinguishing details.

Length and delivery constraints:
- Target 160 to 220 words.
- Hard maximum 250 words.
- Prefer short and medium sentences for clean TTS pacing.
- Avoid tongue-twister phrasing and dense jargon.
- End cleanly with a specific forward-moving final sentence.

Final checks before responding:
- Priorities are in the provided order.
- Script is fully consistent with inputs.
- Plain text only with no extra formatting artifacts.`,
      },
      {
        role: "user",
        content: `Original dump: "${dumpTranscript}"

Call summary: ${callSummary}

Priorities (in order): ${JSON.stringify(priorities)}

Extracted entities: ${JSON.stringify(entities)}

Research findings by query:
${buildResearchContextBlock(researchPlan, firecrawlResults)}

Additional context: ${additionalContext}`,
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

  const audioBuffer = Buffer.from(await ttsRes.arrayBuffer());

  const bucket = storage.bucket();
  const fileName = `brief-${Date.now()}.mp3`;
  const objectPath = `audio/${userId}/${sessionId}/${fileName}`;
  const file = bucket.file(objectPath);

  await file.save(audioBuffer, {
    metadata: { contentType: "audio/mpeg" },
  });

  await file.makePublic();
  const publicUrl = `https://storage.googleapis.com/${bucket.name}/${file.name}`;

  const sessionRef = db
    .collection("User")
    .doc(userId)
    .collection("Sessions")
    .doc(sessionId);

  await sessionRef.update({
    vmUrl: publicUrl,
    vmScript: script,
    status: "complete",
    completedAt: new Date(),
  });

  console.log("Voice message complete", { sessionId, objectPath, publicUrl });
}

