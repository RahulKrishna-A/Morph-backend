import { openai } from "./config.js";

// --- Types ---

export interface Task {
  id: string;
  raw: string;
  cleaned: string;
  type: "work" | "personal" | "communication" | "creative" | "research";
  isVague: boolean;
  urgency: "explicit" | "implicit" | "none";
  needsLocation: boolean;
  locationHint?: string;
  actionable: boolean;
}

export interface Person {
  id: string;
  name: string;
  context: string;
  company?: string;
  wantsToMeet: boolean;
  meetingContext?: string;
}

export interface ResearchTopic {
  id: string;
  topic: string;
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  targetId: string;
  why: string;
}

export interface ExtractionResult {
  tasks: Task[];
  people: Person[];
  researchTopics: ResearchTopic[];
  emotionalTone: "anxious" | "excited" | "foggy" | "overwhelmed" | "clear";
  clarificationQuestions: ClarificationQuestion[];
  priorityQuestion: string;
}

// --- Prompt ---

const EXTRACTION_PROMPT = `
You are a structured extraction engine for a user's brain dump.
Your CORE MISSION: convert messy speech into precise, actionable entities AND generate aggressive clarification questions that extract every detail needed for us to research, prioritize, and give the user everything they need to execute.

You must think like a chief of staff who knows that the more specific information we get NOW, the better the research and final brief will be. Every vague mention is an opportunity to ask a sharp follow-up.

Output requirements:
- Return one valid JSON object only.
- No markdown, no code fences, no commentary, and no trailing text.
- Use exactly the keys in the schema below. Do not add extra keys.
- If a section has no items, return an empty array.

Return this exact schema:
{
  "tasks": [
    {
      "id": "t1",
      "raw": "exact phrase from transcript",
      "cleaned": "clear normalized action statement",
      "type": "work | personal | communication | creative | research",
      "isVague": true,
      "urgency": "explicit | implicit | none",
      "needsLocation": false,
      "locationHint": "city/area if mentioned, otherwise omit",
      "actionable": true
    }
  ],
  "people": [
    {
      "id": "p1",
      "name": "person name as spoken",
      "context": "why this person matters in current tasks",
      "company": "company/org if clearly stated, otherwise omit this key",
      "wantsToMeet": false,
      "meetingContext": "what the meeting is about, if mentioned"
    }
  ],
  "researchTopics": [
    {
      "id": "r1",
      "topic": "topic that requires external lookup"
    }
  ],
  "emotionalTone": "anxious | excited | foggy | overwhelmed | clear",
  "clarificationQuestions": [
    {
      "id": "q1",
      "question": "single sharp question for follow-up call",
      "targetId": "t1 | p1 | r1 | etc",
      "why": "what decision or search becomes possible after answer",
      "category": "location | priority | detail | person | deadline | scope"
    }
  ],
  "priorityQuestion": "one forced-tradeoff question between top priorities"
}

Entity extraction rules:
- Extract only concrete items grounded in the transcript. Never invent.
- Split bundled statements into separate tasks if they can be executed independently.
- Keep "raw" close to the speaker's wording and keep "cleaned" concise and actionable.
- Task type mapping:
  - work: startup, career, product, execution, operations
  - personal: health, home, life admin, self-management
  - communication: follow-ups, outreach, replies, meetings, coordination
  - creative: writing, design, ideation, content creation
  - research: explicit investigation or information-gathering tasks
- isVague = true when key execution details are missing (scope, owner, deadline, deliverable, audience, success criteria, or dependency).
- urgency mapping:
  - explicit: direct urgency words or explicit deadline (today, by 4pm, urgent, ASAP)
  - implicit: urgency inferred from risk/dependency/context without explicit deadline words
  - none: no urgency signal
- Emotional tone selection:
  - anxious: stress or worry language dominates
  - excited: optimistic energy dominates
  - foggy: uncertainty or confusion dominates
  - overwhelmed: too many competing priorities and capacity stress
  - clear: focused, ordered, and calm

Location awareness rules (CRITICAL):
- needsLocation = true for ANY task that involves going somewhere, finding a service, buying something physically, meeting someone, getting something repaired/serviced, visiting a place, dining, traveling, or any real-world action.
- Examples: "get keyboard repaired" → needsLocation=true; "find a good gym" → needsLocation=true; "meet John for coffee" → needsLocation=true; "book flights to NYC" → needsLocation=true; "get groceries" → needsLocation=true.
- locationHint: extract any geographic info mentioned (city, neighborhood, area, "near office", etc). Omit if nothing stated.
- actionable = true when the task can be immediately acted upon with enough info. false when key blockers remain.
- For EVERY task where needsLocation=true and locationHint is missing, you MUST generate a clarification question asking WHERE.

People and meeting intelligence rules (CRITICAL):
- wantsToMeet = true if the user mentions wanting to meet, catch up with, have coffee with, visit, or see this person.
- meetingContext: capture why the meeting matters, what to discuss, relationship context.
- For EVERY person where wantsToMeet=true, generate a researchTopic for that person (their latest work, company news, social profiles, recent activity) so we can brief the user before the meeting.
- If the user mentions wanting to meet someone, generate ONE clarification question that covers the most critical missing detail (when, where, or what to prepare — pick the single most impactful one, not all three).

Clarification question rules (SHARP AND FOCUSED):
- Generate 3 to 6 clarificationQuestions. priorityQuestion is separate.
- Each question must be SELF-CONTAINED and ask for exactly ONE piece of information. Do not combine multiple asks into one question.
- The agent will ask each question and get AT MOST one follow-up per question, so every question must be designed to get a useful answer in one shot.
- Your goal is to cover the most important gaps. Ask about:
  1. LOCATION: "Where do you want to find [service/place]?" for any location-dependent task
  2. PRIORITY: "Which of these matters more to you today: X or Y?"
  3. DETAIL: "What's your budget/timeline/preference for X?"
  4. PERSON: "When do you want to meet [person]?" (single ask, not a compound question)
  5. DEADLINE: "When does X need to be done by?"
  6. SCOPE: "What exactly do you need from X — the full thing or just Y?"
- category field must be one of: location, priority, detail, person, deadline, scope
- Do not ask for details already clear in the transcript.
- Prefer concrete choice or constraint questions over open-ended prompts.
- Each clarification question must reference a valid existing targetId.
- Keep each clarification question under 20 words. Shorter = better answer.
- NEVER combine two questions into one (e.g., "When and where do you want to meet him?" is BAD — split into two separate questions or pick the more important one).
- ALWAYS ask at least one location question if any task involves the real world.
- ALWAYS ask at least one priority/deadline question to understand what matters most.
- Think about what information would help us do the BEST possible web research and give the user the most useful brief.

Research topic generation rules (BE THOROUGH):
- Generate researchTopics for ANYTHING that would benefit from web lookup.
- If someone mentions a person → research that person's latest activity.
- If someone mentions a product/service → research best options, reviews, prices.
- If someone mentions a place/event → research details, logistics, recommendations.
- If someone mentions a company → research latest news, updates.
- If someone mentions a problem → research solutions, services, providers.
- Be liberal: when in doubt, ADD a research topic. More research = better brief.

Priority question rules:
- Always produce exactly one priorityQuestion.
- Force a tradeoff between the top two meaningful tasks.
- Frame the tradeoff by consequence or regret if skipped.
- Make it transcript-specific, never generic.

Quality checks before output:
- IDs are sequential per section: t1.., p1.., r1.., q1...
- Avoid duplicate tasks, people, topics, and questions.
- Every needsLocation=true task without a locationHint has a matching location clarification question.
- Every wantsToMeet=true person has at least one research topic and one clarification question.
- Ensure JSON parses without repair.
`;

/**
 * Step 2b — Extract entities and generate clarification questions
 * from the transcript using GPT-4o.
 */
export async function extractAndGenerateQuestions(
  transcript: string
): Promise<ExtractionResult> {
  console.log("Extracting entities from transcript");



  const res = await openai.chat.completions.create({
    model: "gpt-5.1",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: EXTRACTION_PROMPT },
      { role: "user", content: transcript },
    ],
  });

  const content = res.choices[0].message.content;
  if (!content) {
    throw new Error("GPT-4o returned empty extraction response");
  }

  const parsed = JSON.parse(content) as ExtractionResult;
  console.log("Extraction complete", {
    tasks: parsed.tasks.length,
    people: parsed.people.length,
    questions: parsed.clarificationQuestions.length,
  });

  return parsed;
}

