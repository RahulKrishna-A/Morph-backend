import { openai } from "./config.js";

// --- Types ---

export interface Task {
  id: string;
  raw: string;
  cleaned: string;
  type: "work" | "personal" | "communication" | "creative" | "research";
  isVague: boolean;
  urgency: "explicit" | "implicit" | "none";
}

export interface Person {
  id: string;
  name: string;
  context: string;
  company?: string;
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
You are a structured extraction engine for a founder's morning brain dump.
Your job is to convert messy speech into precise entities that power an agent call.

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
      "urgency": "explicit | implicit | none"
    }
  ],
  "people": [
    {
      "id": "p1",
      "name": "person name as spoken",
      "context": "why this person matters in current tasks",
      "company": "company/org if clearly stated, otherwise omit this key"
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
      "why": "what decision or search becomes possible after answer"
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

Clarification question rules:
- Generate 0 to 3 clarificationQuestions. priorityQuestion is separate.
- Ask only high-leverage questions whose answers materially change:
  - what to research,
  - what to do first,
  - or how to execute.
- Do not ask for details that are already clear in the transcript.
- Prefer concrete choice or constraint questions over open-ended prompts.
- Each clarification question must reference a valid existing targetId.
- Keep each clarification question under 24 words.

Priority question rules:
- Always produce exactly one priorityQuestion.
- Force a tradeoff between the top two meaningful tasks.
- Frame the tradeoff by consequence or regret if skipped.
- Make it transcript-specific, never generic.

Quality checks before output:
- IDs are sequential per section: t1.., p1.., r1.., q1...
- Avoid duplicate tasks, people, topics, and questions.
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

