import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_API_KEY, CLAUDE_MODEL_NAME } from '../config/env';

export const anthropic = new Anthropic({
  apiKey: CLAUDE_API_KEY,
});

/**
 * System prompt for the AI calling agent.
 * The agent RESPONDS conversationally like a real human on the phone.
 * It also translates when needed, but primarily acts as a natural conversational partner.
 */
export const TRANSLATOR_SYSTEM_PROMPT = `You are a helpful human on a phone call. 
Your goal is to be a natural conversational partner. 
- Maintain continuity: Use the provided context to ensure your responses flow logically from previous turns.
- Response Length: Keep your responses concise, strictly between 2 to 3 lines (sentences). 
- Versatility: You are capable of handling any scenario with professional, human-like intelligence.
- Directness: Start with the most relevant information.
- Natural speech: Use natural transitions, avoid overly formal robotic phrasing.`;

// Keep the JSON-based prompt for the /chat REST API (non-WebRTC)
export const SYSTEM_PROMPT = `${TRANSLATOR_SYSTEM_PROMPT}

## STRICT JSON FORMAT
You MUST always respond in this JSON format:
{
  "transcription": "What you understood the user said (in original language).",
  "reply": "Your conversational response."
}

Example:
{
  "transcription": "Hello, how are you?",
  "reply": "I'm doing well, thank you! How can I help you today?"
}`;

/**
 * Create translation request message with context
 */
export function createTranslationRequest(
  text: string,
  sourceLang: string = 'auto',
  targetLang: string = 'ur',
  context: Array<{ speaker: string; text: string }> = [],
  interruptedResponse?: string,
  interruptedQuestion?: string
): string {
  let prompt = '';

  // Add conversation context if available
  if (context.length > 0) {
    prompt += `[Previous conversation context:\n`;
    context.slice(-2).forEach(msg => {
      prompt += `${msg.speaker}: ${msg.text}\n`;
    });
    prompt += `]\n\n`;
  }

  // Handle interruption context
  if (interruptedQuestion && interruptedResponse) {
    prompt += `[IMPORTANT: You were interrupted while answering: "${interruptedQuestion}"]\n`;
    prompt += `[You had said: "${interruptedResponse}"... when the user spoke again.]\n`;
    prompt += `[The user's new input is below. Please provide a comprehensive response that addresses BOTH their previous question and this new input naturally.]\n\n`;
  } else if (interruptedResponse) {
    prompt += `[IMPORTANT: You were interrupted while saying: "${interruptedResponse}"...]\n`;
    prompt += `[The user spoke while you were talking. Address their new input while acknowledging or continuing from where you were if relevant.]\n\n`;
  }

  // Build the request — keep it minimal for speed
  if (sourceLang === targetLang || sourceLang === 'auto') {
    // Same language or auto-detect: just respond naturally
    prompt += text;
  } else {
    // Different languages: translate and respond
    prompt += `[Caller speaks ${sourceLang}, respond in Pakistani Urdu]\n${text}`;
  }

  return prompt;
}

/**
 * Create a streaming Claude response (for WebRTC real-time pipeline)
 * Optimized for LOW LATENCY — short max_tokens, high temperature for naturalness
 */
export const createTranslationStream = (
  text: string,
  targetLang: string,
  sourceLang: string = 'auto',
  history: any[] = [],
  signal?: AbortSignal,
  interruptedResponse?: string,
  interruptedQuestion?: string
) => {
  const message = createTranslationRequest(text, sourceLang, targetLang, [], interruptedResponse, interruptedQuestion);

  return anthropic.messages.stream({
    model: CLAUDE_MODEL_NAME,
    max_tokens: 150,        // Increased to ensure full Urdu sentences are not cut off
    temperature: 0.3,      // Faster token selection
    system: TRANSLATOR_SYSTEM_PROMPT,
    messages: [
      ...history,
      { role: 'user', content: message }
    ],
  }, { signal });
};


/**
 * Non-streaming translation (fallback)
 */
export const translateText = async (
  text: string,
  targetLang: string,
  sourceLang: string = 'auto',
  history: any[] = [],
  signal?: AbortSignal
): Promise<{ translation: string; latency: number }> => {
  const startTime = Date.now();
  const message = createTranslationRequest(text, sourceLang, targetLang);

  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL_NAME,
    max_tokens: 200,        // Increased for fallback completeness
    temperature: 0.4,
    system: TRANSLATOR_SYSTEM_PROMPT,
    messages: [
      ...history,
      { role: 'user', content: message }
    ],
  }, { signal });

  const translation = (response.content[0] as any).text;
  const latency = Date.now() - startTime;

  return { translation, latency };
};

/**
 * Create stream for JSON-based /chat endpoint (legacy)
 */
export const createStream = (message: string, history: any[]) => {
  return anthropic.messages.stream({
    model: CLAUDE_MODEL_NAME,
    max_tokens: 80,
    temperature: 0.4,
    system: SYSTEM_PROMPT,
    messages: [
      ...history,
      { role: 'user', content: message }
    ],
  });
};

export { CLAUDE_MODEL_NAME };

console.log(`Claude Service Initialized with model: ${CLAUDE_MODEL_NAME}`);
