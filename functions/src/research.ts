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
  categories?: string[];
  tbs?: string | null;
  limit?: number;
  scrapeOptions?: { formats: string[] };
}

interface FirecrawlSourceRow {
  title?: unknown;
  url?: unknown;
  markdown?: unknown;
  description?: unknown;
  content?: unknown;
}

interface SearchSource {
  title: string;
  url: string;
  snippet: string;
  content: string;
}

interface ResearchPlanItem {
  key: string;
  query: string;
}

type FirecrawlSearchResponse = {
  data?: unknown;
  web?: unknown;
};

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from",
  "how", "i", "in", "is", "it", "of", "on", "or", "that", "the",
  "this", "to", "was", "what", "when", "where", "which", "who", "why",
  "with", "you", "your", "near", "best", "top", "latest", "news",
]);

function cleanText(...values: Array<unknown>): string {
  const raw = values.find((value) => typeof value === "string" && value.trim());
  if (typeof raw !== "string") {
    return "";
  }

  return raw
    .replace(/!\[[^\]]*]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\(([^)]*)\)/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }

  const url = value.trim();
  if (!url) {
    return "";
  }

  try {
    return new URL(url).toString();
  } catch {
    return "";
  }
}

function normalizeSources(raw: unknown): SearchSource[] {
  const candidates =
    typeof raw === "object" && raw !== null && "data" in raw
      ? (raw as Record<string, unknown>).data
      : raw;

  const rows = Array.isArray(candidates)
    ? candidates
    : typeof candidates === "object" &&
      candidates !== null &&
      Array.isArray((candidates as Record<string, unknown>).web)
      ? (candidates as Record<string, unknown>).web as unknown[]
      : [];

  return rows
    .map((row) => {
      const source =
        typeof row === "object" && row !== null
          ? (row as FirecrawlSourceRow)
          : {};

      const url = cleanUrl(source.url);
      if (!url) {
        return null;
      }

      const title = cleanText(source.title, source.url, "Untitled source");
      const snippet = cleanText(
        source.description,
        source.content,
        source.markdown
      ).slice(0, 320);
      const content = cleanText(
        source.content,
        source.markdown,
        source.description
      ).slice(0, 3200);

      return {
        title,
        url,
        snippet,
        content,
      } satisfies SearchSource;
    })
    .filter((source): source is SearchSource => source !== null);
}

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    parsed.searchParams.delete("utm_source");
    parsed.searchParams.delete("utm_medium");
    parsed.searchParams.delete("utm_campaign");
    parsed.searchParams.delete("utm_term");
    parsed.searchParams.delete("utm_content");
    parsed.searchParams.delete("gclid");
    parsed.searchParams.delete("fbclid");
    return parsed.toString();
  } catch {
    return url;
  }
}

function dedupeSources(sources: SearchSource[]): SearchSource[] {
  const seen = new Set<string>();
  return sources.filter((source) => {
    const canonical = canonicalUrl(source.url);
    if (seen.has(canonical)) {
      return false;
    }
    seen.add(canonical);
    return true;
  });
}

function buildKeywords(query: string, priorities: string[]): string[] {
  const combined = `${query} ${priorities.slice(0, 3).join(" ")}`.toLowerCase();
  const words = combined
    .split(/[^a-z0-9]+/)
    .map((word) => word.trim())
    .filter(
      (word) =>
        word.length >= 3 &&
        !STOPWORDS.has(word)
    );
  return Array.from(new Set(words)).slice(0, 18);
}

function scoreSentence(sentence: string, keywords: string[]): number {
  const lower = sentence.toLowerCase();
  return keywords.reduce((score, keyword) => {
    if (!lower.includes(keyword)) {
      return score;
    }

    return score + (keyword.length >= 6 ? 2 : 1);
  }, 0);
}

function pickRelevantExcerpt(content: string, keywords: string[]): string {
  const cleaned = cleanText(content);
  if (!cleaned) {
    return "";
  }

  const sentenceRows = cleaned
    .split(/(?<=[.!?])\s+/)
    .map((sentence, index) => ({
      sentence: sentence.trim(),
      index,
      score: 0,
    }))
    .filter((row) => row.sentence.length >= 35)
    .map((row) => ({
      ...row,
      score: scoreSentence(row.sentence, keywords),
    }));

  if (sentenceRows.length === 0) {
    return cleaned.slice(0, 900);
  }

  const topRows = sentenceRows
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 4);

  const selected = (topRows.length > 0 ? topRows : sentenceRows.slice(0, 3))
    .sort((a, b) => a.index - b.index)
    .map((row) => row.sentence)
    .join(" ");

  return selected.slice(0, 900);
}

// --- Firecrawl search helper ---

async function firecrawlSearch(
  apiKey: string,
  job: SearchJob
): Promise<FirecrawlSearchResponse> {
  if (!apiKey || !job.query.trim()) {
    return { data: [] };
  }

  try {
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

    return await res.json() as FirecrawlSearchResponse;
  } catch (error) {
    console.warn("Firecrawl search exception", { key: job.key, error });
    return { data: [] };
  }
}

async function firecrawlScrape(apiKey: string, url: string): Promise<string> {
  if (!apiKey || !url) {
    return "";
  }

  try {
    const res = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.warn("Firecrawl scrape failed", { url, error: errText });
      return "";
    }

    const payload = await res.json() as unknown;
    const data =
      typeof payload === "object" && payload !== null && "data" in payload
        ? (payload as Record<string, unknown>).data
        : payload;

    if (typeof data !== "object" || data === null) {
      return "";
    }

    const row = data as Record<string, unknown>;
    return cleanText(row.markdown, row.content, row.description);
  } catch (error) {
    console.warn("Firecrawl scrape exception", { url, error });
    return "";
  }
}

async function summarizeScrapedContent(
  scrapedContent: string,
  query: string,
  priorities: string[]
): Promise<string> {
  if (!scrapedContent || scrapedContent.length < 80) {
    return scrapedContent;
  }

  try {
    const res = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 600,
      messages: [
        {
          role: "system",
          content: `Extract the most relevant facts from the web page that answer the search query. Return a concise summary (3-8 sentences) with only useful specifics: names, prices, ratings, addresses, phone numbers, hours, features, comparisons, dates. Omit navigation, ads, cookie banners, and boilerplate. If nothing relevant exists, return exactly "NO_RELEVANT_INFO".`,
        },
        {
          role: "user",
          content: `Search query: "${query}"\nContext priorities: ${priorities.slice(0, 3).join("; ")}\n\nPage content:\n${scrapedContent.slice(0, 6000)}`,
        },
      ],
    });

    const summary = res.choices[0].message.content?.trim() ?? "";
    if (summary === "NO_RELEVANT_INFO" || !summary) {
      return "";
    }
    return summary;
  } catch (error) {
    console.warn("Source summarization failed, falling back to keyword excerpt", { error });
    return "";
  }
}

async function enrichSource(
  apiKey: string,
  source: SearchSource,
  keywords: string[],
  query: string,
  priorities: string[]
): Promise<SearchSource> {
  const scrapedContent = await firecrawlScrape(apiKey, source.url);
  const fullContent = cleanText(scrapedContent, source.content, source.snippet);

  const gptSummary = await summarizeScrapedContent(fullContent, query, priorities);
  console.log("GPT summary", { gptSummary });

  const finalContent = gptSummary
    ? gptSummary
    : pickRelevantExcerpt(fullContent, keywords);

  return {
    ...source,
    snippet: cleanText(source.snippet, finalContent).slice(0, 400),
    content: finalContent.slice(0, 2200),
  };
}

async function researchSearchJob(
  apiKey: string,
  job: SearchJob,
  priorities: string[]
): Promise<Array<{ title: string; url: string; content: string }>> {
  const response = await firecrawlSearch(apiKey, job);
  const sources = dedupeSources(normalizeSources(response)).slice(0, 5);
  if (sources.length === 0) {
    return [];
  }

  const keywords = buildKeywords(job.query, priorities);
  const enriched = await Promise.allSettled(
    sources.map((source) =>
      enrichSource(apiKey, source, keywords, job.query, priorities)
    )
  );

  const refined: SearchSource[] = [];
  enriched.forEach((result, index) => {
    if (result.status === "fulfilled") {
      if (result.value.content) {
        refined.push(result.value);
      }
      return;
    }

    console.warn("Source enrichment failed", {
      key: job.key,
      url: sources[index]?.url,
      error: result.reason,
    });
  });

  return refined.slice(0, 3).map((source) => ({
    title: source.title,
    url: source.url,
    content: source.content,
  }));
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
        content: `You transform a call summary plus the original brain dump into execution priorities and targeted research jobs.

Return one valid JSON object with exactly this shape:
{
  "priorities": ["highest priority first", "next", "..."],
  "searchJobs": [
    {
      "key": "search_1",
      "query": "specific search query",
      "type": "web | news | github | research",
      "recency": "hour | day | week | any",
      "urgent": true
    }
  ],
  "additionalContext": "short context that helps downstream response quality"
}

Hard output constraints:
- JSON only. No markdown, no code fences, no extra keys.
- priorities must be non-empty when the summary contains actionable work.
- priorities must be deduplicated, concrete, and ordered by the user's stated ranking.
- If ranking is not explicit, infer order from deadline pressure, dependency chains, and consequence of delay.
- Each priority should be a concise action/outcome statement (roughly 4-16 words).

Search job selection rules:
- Create searchJobs only for questions that require external information not present in the provided text.
- Do not create searchJobs for pure execution reminders, self-reflection, or tasks that can be done without lookup.
- Keep searchJobs between 0 and 6 items.
- Avoid duplicate or overlapping queries.
- key must be sequential: search_1, search_2, ...
- query must be practical search-bar text, specific and disambiguated.

Type rules:
- news: current events, market moves, funding, launches, leadership changes, recent announcements.
- github: repositories, SDK docs, issues, package compatibility, implementation examples.
- research: technical papers, benchmarks, deep domain explainers.
- web: all other general web lookups.

Recency rules:
- hour: breaking updates needed immediately.
- day: updates from the last 24 hours matter.
- week: recent developments matter but not minute-by-minute.
- any: timeless/background information.

Urgency rules:
- urgent=true only if the lookup blocks a near-term decision or same-day action.
- urgent=false for background or non-blocking context.

additionalContext rules:
- 1 to 3 short sentences.
- Include constraints, user preferences, assumptions, or risks that should influence final messaging.
- Keep it useful and specific; no generic filler.

If nothing needs external lookup, return "searchJobs": [] and still provide priorities plus additionalContext.
Perform a final self-check for parseable JSON and schema compliance before responding.`,
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
    tbs: recencyToTbs[j.recency] ?? null,
    limit: 3,
    scrapeOptions: { formats: ["markdown"] },
  }));

  const allSearchJobs: SearchJob[] = [...peopleSearches, ...summarySearches];
  const researchPlan: ResearchPlanItem[] = allSearchJobs.map((job) => ({
    key: job.key,
    query: job.query,
  }));

  console.log("Running research searches", {
    sessionId,
    jobCount: allSearchJobs.length,
  });

  const searchResults = await Promise.allSettled(
    allSearchJobs.map((job) =>
      researchSearchJob(FIRECRAWL_API_KEY, job, priorities)
    )
  );

  const firecrawlResults: Record<
    string,
    Array<{ title: string; url: string; content: string }>
  > = {};
  searchResults.forEach((result, i) => {
    const key = allSearchJobs[i].key;
    if (result.status === "fulfilled") {
      firecrawlResults[key] = result.value;
      return;
    }

    console.warn("Search job failed", {
      key,
      error: result.reason,
    });
    firecrawlResults[key] = [];
  });

  const userId = sessionData.userId ?? "unknown";

  await db
    .collection("User")
    .doc(userId)
    .collection("Sessions")
    .doc(sessionId)
    .update({
      firecrawlResults,
      researchPlan,
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
    researchPlan,
    entities: extractedEntities,
  });
}

