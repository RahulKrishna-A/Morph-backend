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
You are analyzing a morning brain dump.

Return this exact JSON:

{
  "tasks": [
    {
      "id": "t1",
      "raw": "exactly what they said",
      "cleaned": "normalized version",
      "type": "work | personal | communication | creative | research",
      "isVague": true | false,
      "urgency": "explicit | implicit | none"
    }
  ],
  "people": [{ "id": "p1", "name": "string", "context": "why mentioned" }],
  "researchTopics": [{ "id": "r1", "topic": "string" }],
  "emotionalTone": "anxious | excited | foggy | overwhelmed | clear",

  "clarificationQuestions": [
    {
      "id": "q1",
      "question": "exact question for the agent to ask",
      "targetId": "t1 or p1 etc — what entity this clarifies",
      "why": "one line — what becomes searchable after this answer"
    }
  ],

  "priorityQuestion": "one regret-framing question specific to their tasks.
    Example: 'If you only got one thing done today — the auth PR or the
    investor prep — which would hurt more to skip?'"
}

QUESTION RULES:
- Max 4 questions total including the priority question
- Only ask about things that genuinely change what research to do
- Do NOT ask about things already clear from the dump
- Priority question always goes last
- Questions should feel like a sharp co-founder asking, not a form
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
