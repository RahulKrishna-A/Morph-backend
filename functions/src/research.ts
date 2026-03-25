import { openai, db, FIRECRAWL_API_KEY } from "./config.js";
import type { Person } from "./extract.js";
import { buildVoiceMessage } from "./voiceMessage.js";

// --- Types ---

interface AnswerExtraction {
  questionId: string;
  question: string;
  answer: string;
  urgencyConfirmed: boolean;
  needsSearch: boolean;
  searchQuery: string | null;
  searchType: "web" | "news" | "github" | "research" | null;
  recency: "hour" | "day" | "week" | "any" | null;
}

interface AnswersResult {
  answers: AnswerExtraction[];
  priorityOrder: string[];
  additionalContext: string;
}

interface SearchJob {
  key: string;
  query: string;
  sources: string[];
  categories?: string[];
  tbs?: string | null;
  limit?: number;
  scrapeOptions?: { formats: string[] };
}

// --- Firecrawl search helper ---

async function firecrawlSearch(
  apiKey: string,
  job: SearchJob
): Promise<{ data?: Array<{ title: string; url: string; markdown?: string; description?: string }> }> {
  const res = await fetch("https://api.firecrawl.dev/v1/search", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: job.query,
      limit: job.limit ?? 3,
      scrapeOptions: job.scrapeOptions ?? { formats: ["markdown"] },
      ...(job.tbs ? { tbs: job.tbs } : {}),
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.warn("Firecrawl search failed", { key: job.key, error: errText });
    return { data: [] };
  }

  return res.json() as Promise<{ data: Array<{ title: string; url: string; markdown?: string; description?: string }> }>;
}

/**
 * Step 6 — Parse call answers, run research searches, then build VM.
 */
export async function buildResearchAndVM(
  sessionId: string,
  sessionData: FirebaseFirestore.DocumentData,
  callTranscript: string
): Promise<void> {
  const {
    extractedEntities,
    clarificationQuestions,
    transcript: dumpTranscript,
  } = sessionData;



  // Step A: Extract answers from the call transcript
  console.log("Extracting answers from call transcript", { sessionId });

  const answersExtraction = await openai.chat.completions.create({
    model: "gpt-5.1",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `
          You are given a list of questions that were asked in a call,
          and the full call transcript. 
          
          Extract the user's answer to each question.
          
          Return JSON:
          {
            "answers": [
              {
                "questionId": "q1",
                "question": "string",
                "answer": "exactly what they said",
                "urgencyConfirmed": true | false,
                "needsSearch": true | false,
                "searchQuery": "string if needsSearch, else null",
                "searchType": "web | news | github | research | null",
                "recency": "hour | day | week | any | null"
              }
            ],
            "priorityOrder": ["task description 1", "task description 2", "task description 3"],
            "additionalContext": "anything else useful the user mentioned during the call"
          }
        `,
      },
      {
        role: "user",
        content: `
          Questions asked: ${JSON.stringify(clarificationQuestions)}
          
          Full call transcript: ${JSON.stringify(callTranscript)}
        `,
      },
    ],
  });

  const answersContent = answersExtraction.choices[0].message.content;
  if (!answersContent) {
    throw new Error("GPT-4o-mini returned empty answer extraction");
  }

  const { answers, priorityOrder, additionalContext } =
    JSON.parse(answersContent) as AnswersResult;

  // Step B: Build certain searches from people entities
  const people = (extractedEntities.people ?? []) as Person[];
  const certainSearches: SearchJob[] = people.map((p) => ({
    key: p.id,
    query: `${p.name} ${p.company ?? ""} news`.trim(),
    sources: ["news", "web"],
    tbs: "qdr:w",
  }));

  // Step C: Build full search job list
  const allSearchJobs: SearchJob[] = [
    ...certainSearches,
    ...answers
      .filter((a) => a.needsSearch && a.searchQuery)
      .map((a) => ({
        key: a.questionId,
        query: a.searchQuery!,
        sources: a.searchType === "news" ? ["news"] : ["web"],
        categories: ["github", "research"].includes(a.searchType ?? "")
          ? [a.searchType!]
          : undefined,
        tbs:
          ({
            hour: "qdr:h",
            day: "qdr:d",
            week: "qdr:w",
            any: null,
          } as Record<string, string | null>)[a.recency ?? "any"] ?? null,
        limit: 3,
        scrapeOptions: { formats: ["markdown"] },
      })),
  ];

  // Step D: Run all searches in parallel via Firecrawl
  console.log("Running research searches", {
    sessionId,
    jobCount: allSearchJobs.length,
  });

  const apiKey = FIRECRAWL_API_KEY;

  const searchResults = await Promise.allSettled(
    allSearchJobs.map((job) => firecrawlSearch(apiKey, job))
  );

  const firecrawlResults: Record<
    string,
    Array<{ title: string; url: string; content: string }>
  > = {};
  searchResults.forEach((result, i) => {
    if (result.status === "fulfilled") {
      firecrawlResults[allSearchJobs[i].key] =
        result.value.data
          ?.slice(0, 2)
          .map((item) => ({
            title: item.title,
            url: item.url,
            content:
              item.markdown?.slice(0, 500) ?? item.description ?? "",
          })) ?? [];
    }
  });

  // Save research results
  await db
    .collection("User")
    .doc(sessionData.userId ?? "unknown")
    .collection("Sessions")
    .doc(sessionId)
    .update({
      firecrawlResults,
      answers,
      priorityOrder,
      status: "building_vm",
    });

  console.log("Research complete, building voice message", { sessionId });

  // Step E: Build the voice message
  await buildVoiceMessage(sessionId, sessionData.userId ?? "unknown", {
    dumpTranscript,
    answers,
    priorityOrder,
    additionalContext,
    firecrawlResults,
    entities: extractedEntities,
  });
}
