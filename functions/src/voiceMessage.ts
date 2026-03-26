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
    tasks: Array<{ cleaned: string; needsLocation?: boolean; locationHint?: string }>;
    people: Array<{ name: string; wantsToMeet?: boolean; meetingContext?: string; company?: string }>;
    researchTopics: Array<{ topic: string }>;
    emotionalTone: string;
  };
  locationSearches?: Array<{ key: string; query: string; location: string; taskRef: string }>;
  meetingPrep?: Array<{ key: string; personName: string; queries: string[] }>;
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
    const rows = (firecrawlResults[item.key] ?? []).slice(0, 5);
    if (rows.length === 0) {
      return `Query: ${item.query}\nNo strong external signal found.`;
    }

    const sourceLines = rows.map((row, index) => {
      const excerpt = row.content.slice(0, 1200);
      return `${index + 1}. ${row.title} (${sourceLabel(row.url)})\n${excerpt}`;
    });

    return `Query: ${item.query}\n${sourceLines.join("\n\n")}`;
  });

  return sections.join("\n\n---\n\n");
}

function buildLocationContextBlock(
  locationSearches: Array<{ key: string; query: string; location: string; taskRef: string }>,
  firecrawlResults: Record<string, Array<{ title: string; url: string; content: string }>>
): string {
  if (locationSearches.length === 0) return "";

  const sections = locationSearches.map((ls) => {
    const rows = (firecrawlResults[ls.key] ?? []).slice(0, 5);
    if (rows.length === 0) {
      return `Location search: ${ls.query}\nNo results found for ${ls.location}.`;
    }

    const sourceLines = rows.map((row, index) => {
      const excerpt = row.content.slice(0, 1000);
      return `${index + 1}. ${row.title} (${sourceLabel(row.url)})\n${excerpt}`;
    });

    return `Location search: ${ls.query} (${ls.location})\n${sourceLines.join("\n\n")}`;
  });

  return sections.join("\n\n---\n\n");
}

function buildMeetingPrepBlock(
  meetingPrep: Array<{ key: string; personName: string; queries: string[] }>,
  firecrawlResults: Record<string, Array<{ title: string; url: string; content: string }>>
): string {
  if (meetingPrep.length === 0) return "";

  const sections = meetingPrep.map((mp) => {
    const allResults = mp.queries.flatMap((_q, qi) => {
      const key = `${mp.key}_q${qi + 1}`;
      return (firecrawlResults[key] ?? []).slice(0, 3);
    });

    if (allResults.length === 0) {
      return `Person: ${mp.personName}\nNo recent intel found.`;
    }

    const sourceLines = allResults.slice(0, 5).map((row, index) => {
      const excerpt = row.content.slice(0, 800);
      return `${index + 1}. ${row.title} (${sourceLabel(row.url)})\n${excerpt}`;
    });

    return `Person: ${mp.personName}\n${sourceLines.join("\n\n")}`;
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
    locationSearches = [],
    meetingPrep = [],
  } = data;

  console.log("Building voice message script", { sessionId });

  const locationBlock = buildLocationContextBlock(locationSearches, firecrawlResults);
  const meetingBlock = buildMeetingPrepBlock(meetingPrep, firecrawlResults);
  const meetPeople = (entities.people ?? []).filter((p) => p.wantsToMeet);
  const locationTasks = (entities.tasks ?? []).filter((t) => t.needsLocation);

  const scriptRes = await openai.chat.completions.create({
    model: "gpt-5.1",
    messages: [
      {
        role: "system",
        content: `You are writing a personalized spoken daily brief that will be converted directly into TTS audio.
Your goal is to give the user MAXIMUM ACTIONABLE VALUE — clarity on priorities, concrete research findings, specific recommendations, and everything they need to execute immediately.

Output format requirements:
- Return plain text only.
- No markdown, no bullets, no numbered lists, no headings, no emojis.
- Write natural spoken prose suitable for text-to-speech.

Required structure and order:
1. One-sentence opening that orients the user to today and acknowledges their energy/state.
2. Priority guidance: walk through priorities in the exact provided order, naturally in speech.
3. Location-based findings: for tasks that need places/services, give SPECIFIC recommendations with names, addresses, ratings, phone numbers, hours — whatever the research found. Present the top 2-3 options with distinguishing details so the user can choose immediately.
4. People intel: for anyone the user wants to meet, share key insights — what they've been up to, recent news about their company, talking points the user should know. Frame this as "before you meet X, here's what you should know..."
5. Other research insights: include high-signal findings tied to remaining priorities.
6. One-sentence close that names the SINGLE most important next action.

Voice and style rules:
- Sound like a trusted chief of staff who has done thorough homework: calm, direct, practical, data-rich.
- Use conversational language and contractions when natural.
- Avoid hype, filler, and generic motivational lines.
- Do not mention being an AI or doing "research" in abstract terms.
- When giving location-based recommendations, be SPECIFIC: "I found three good options near [area]..." not "there are some options available."

Content rules:
- Respect the user's emotional context without sounding dramatic.
- For each priority, include a concrete next step, decision point, or sequencing cue.
- Use only facts present in provided search results. Never invent facts, names, numbers, dates, or claims.
- Weave specific details from research findings directly into the brief: names, prices, ratings, locations, hours, phone numbers, comparisons, and other concrete data points the user needs.
- For location searches: highlight top 2-3 places with their key differentiators (rating, price, distance, specialty, hours).
- For meeting prep: share the most interesting/relevant 2-3 facts about the person that would make the user more prepared.
- Mention sources casually when used (for example publication/site names), but never read full URLs.
- If a result is weak or ambiguous, phrase it with appropriate uncertainty.
- Skip search items that contain no useful signal.
- If there are no meaningful findings for a topic, briefly acknowledge that and continue.
- When research provides multiple options, ALWAYS highlight the top choices with distinguishing details.

Length and delivery constraints:
- Target 200 to 300 words. If there's rich research to share, go up to 350.
- Hard maximum 400 words.
- Prefer short and medium sentences for clean TTS pacing.
- Avoid tongue-twister phrasing and dense jargon.
- End cleanly with a specific forward-moving final sentence.

Final checks before responding:
- Priorities are in the provided order.
- All location findings are included with specifics.
- All meeting prep intel is included.
- Script is fully consistent with inputs.
- Plain text only with no extra formatting artifacts.`,
      },
      {
        role: "user",
        content: `Original dump: "${dumpTranscript}"

Call summary: ${callSummary}

Priorities (in order): ${JSON.stringify(priorities)}

Extracted entities: ${JSON.stringify(entities)}
${locationTasks.length > 0 ? `\nLocation-dependent tasks: ${JSON.stringify(locationTasks.map((t) => ({ task: t.cleaned, location: t.locationHint })))}` : ""}
${meetPeople.length > 0 ? `\nPeople to meet: ${JSON.stringify(meetPeople.map((p) => ({ name: p.name, company: p.company, context: p.meetingContext })))}` : ""}

Research findings by query:
${buildResearchContextBlock(researchPlan, firecrawlResults)}
${locationBlock ? `\nLocation-based findings:\n${locationBlock}` : ""}
${meetingBlock ? `\nMeeting preparation intel:\n${meetingBlock}` : ""}

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

