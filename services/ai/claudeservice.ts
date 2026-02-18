import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_API_KEY, CLAUDE_MODEL_NAME } from '../../config/env';

export const anthropic = new Anthropic({
    apiKey: CLAUDE_API_KEY,
});

// System prompt for the AI calling agent.
export const TRANSLATOR_SYSTEM_PROMPT = `You are a helpful human on a phone call. 
Your goal is to be a natural conversational partner. 
- Maintain continuity: Use the provided context to ensure your responses flow logically from previous turns.
- Handle Interruptions: If you were interrupted, you will be provided with what you were saying and the user's new input. Your priority is to address the user's new input while seamlessly connecting it to what you were previously saying or the topic under discussion.
- Acknowledge and Pivot: Briefly acknowledge the user's interruption (e.g., "Ah, I see," or "Sure, let's talk about that instead") if it feels natural, then answer their new point.
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

export function createTranslationRequest(
    text: string,
    sourceLang: string = 'auto',
    targetLang: string = 'ur',
    context: Array<{ speaker: string; text: string }> = [],
    interruptedResponse?: string,
    interruptedQuestion?: string
): string {
    let prompt = '';

    if (context.length > 0) {
        prompt += `[Previous conversation context:\n`;
        context.slice(-2).forEach(msg => {
            prompt += `${msg.speaker}: ${msg.text}\n`;
        });
        prompt += `]\n\n`;
    }

    if (interruptedQuestion && interruptedResponse) {
        prompt += `[CONTEXT: You were interrupted while answering the user's previous question: "${interruptedQuestion}"]\n`;
        prompt += `[WHAT YOU HAD SAID BEFORE INTERRUPTION: "${interruptedResponse}..."]\n`;
        prompt += `[USER'S NEW INPUT: "${text}"]\n`;
        prompt += `[INSTRUCTION: Please provide a response that addresses the user's new input, while naturally closing or pivoting from the previous topic if it's still relevant. Combine the context of both speeches into your answer.]\n\n`;
    } else if (interruptedResponse) {
        prompt += `[CONTEXT: You were interrupted while saying: "${interruptedResponse}..."]\n`;
        prompt += `[USER'S NEW INPUT: "${text}"]\n`;
        prompt += `[INSTRUCTION: Address the user's new input. Acknowledge the interruption naturally if appropriate.]\n\n`;
    } else {
        if (sourceLang === targetLang || sourceLang === 'auto') {
            prompt += text;
        } else {
            prompt += `[Caller speaks ${sourceLang}, respond in Pakistani Urdu]\n${text}`;
        }
    }

    return prompt;
}

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
        max_tokens: 150,
        temperature: 0.3,
        system: TRANSLATOR_SYSTEM_PROMPT,
        messages: [
            ...history,
            { role: 'user', content: message }
        ],
    }, { signal });
};

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
        max_tokens: 200,
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
