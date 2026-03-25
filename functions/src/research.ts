import { openai, db, FIRECRAWL_API_KEY } from "./config.js";
import type { Person } from "./extract.js";
import { buildVoiceMessage } from "./voiceMessage.js";

// --- Types ---

interface SummaryExtraction {
  priorities: string[];
  searchJobs: Array<{
    key: string;
    query: string;
    type: "web" | "news" | "github" | "research";
    recency: "hour" | "day" | "week" | "any";
    urgent: boolean;
  }>;
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
 * Step 6 — Extract search queries & priorities from the call summary,
 * run research, then build the voice message.
 */
export async function buildResearchAndVM(
  sessionId: string,
  sessionData: FirebaseFirestore.DocumentData,
  callSummary: string
): Promise<void> {
  const { extractedEntities, transcript: dumpTranscript } = sessionData;

  console.log("Extracting search intent from call summary", { sessionId });

  const extraction = await openai.chat.completions.create({
    model: "gpt-5.1",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content: `You receive a call summary and the user's original brain dump.
Extract what needs to be searched and the user's priorities.

Return JSON:
{
  "priorities": ["highest priority task", "second", ...],
  "searchJobs": [
    {
      "key": "search_1",
      "query": "concise search query",
      "type": "web | news | github | research",
      "recency": "hour | day | week | any",
      "urgent": true | false
    }
  ],
  "additionalContext": "anything else useful from the summary"
}

RULES:
- Only include searchJobs for things that genuinely need a web/news lookup.
- Keep queries short and specific — what you'd actually type into a search bar.
- Priorities should be ordered by how the user ranked them in the call.
- If nothing needs searching, return an empty searchJobs array.`,
      },
      {
        role: "user",
        content: `Call summary: ${callSummary}\n\nOriginal dump: ${dumpTranscript}`,
      },
    ],
  });

  const raw = extraction.choices[0].message.content;
  if (!raw) throw new Error("Empty extraction from call summary");

  const { priorities, searchJobs, additionalContext } =
    JSON.parse(raw) as SummaryExtraction;

  // People-entity searches (always run)
  const people = (extractedEntities.people ?? []) as Person[];
  const peopleSearches: SearchJob[] = people.map((p) => ({
    key: `person_${p.id}`,
    query: `${p.name} ${p.company ?? ""} news`.trim(),
    sources: ["news", "web"],
    tbs: "qdr:w",
  }));

  const recencyToTbs: Record<string, string | null> = {
    hour: "qdr:h",
    day: "qdr:d",
    week: "qdr:w",
    any: null,
  };

  const summarySearches: SearchJob[] = searchJobs.map((j) => ({
    key: j.key,
    query: j.query,
    sources: j.type === "news" ? ["news"] : ["web"],
    categories: ["github", "research"].includes(j.type) ? [j.type] : undefined,
    tbs: recencyToTbs[j.recency] ?? null,
    limit: 3,
    scrapeOptions: { formats: ["markdown"] },
  }));

  const allSearchJobs: SearchJob[] = [...peopleSearches, ...summarySearches];

  console.log("Running research searches", {
    sessionId,
    jobCount: allSearchJobs.length,
  });

  const searchResults = await Promise.allSettled(
    allSearchJobs.map((job) => firecrawlSearch(FIRECRAWL_API_KEY, job))
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
            content: item.markdown?.slice(0, 500) ?? item.description ?? "",
          })) ?? [];
    }
  });

  const userId = sessionData.userId ?? "unknown";

  await db
    .collection("User")
    .doc(userId)
    .collection("Sessions")
    .doc(sessionId)
    .update({
      firecrawlResults,
      priorities,
      status: "building_vm",
    });

  console.log("Research complete, building voice message", { sessionId });

  await buildVoiceMessage(sessionId, userId, {
    dumpTranscript,
    callSummary,
    priorities,
    additionalContext,
    firecrawlResults,
    entities: extractedEntities,
  });
}
