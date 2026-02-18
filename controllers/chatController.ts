import { Request, Response } from 'express';
import { anthropic, SYSTEM_PROMPT, CLAUDE_MODEL_NAME } from '../services/claudeService';
import { mapHistoryToClaude } from '../utils/mapper';

export const chatHandler = async (req: Request, res: Response): Promise<void> => {
    try {
        const { message, history } = req.body;

        console.log('Received message:', message);
        console.log('History length:', (history || []).length);

        const response = await anthropic.messages.create({
            model: CLAUDE_MODEL_NAME,
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            messages: [
                ...mapHistoryToClaude(history),
                { role: 'user', content: message }
            ],
        });

        const text = (response.content[0] as any).text;

        console.log('Claude Raw Response:', text);

        if (!text) {
            console.error('Claude returned empty response content');
            res.status(500).json({ error: 'Empty response from AI service' });
            return;
        }

        try {
            const jsonResponse = JSON.parse(text);
            res.json(jsonResponse);
        } catch (e) {
            console.error('Failed to parse Claude JSON:', e);
            console.error('Raw text that failed parsing:', text);
            // Fallback for non-JSON response
            res.json({ transcription: message, reply: text });
        }
    } catch (error: any) {
        console.error('=== /chat ERROR ===');
        console.error('Raw error object:', JSON.stringify(error, null, 2));
        console.error('Status:', error.status);
        console.error('Message:', error.message);

        let statusCode = 500;
        let errorMessage = 'Internal Server Error';

        if (error.status === 404) {
            // If Anthropic returns 404, it means model not found or invalid URL, 
            // we return 502 to avoid client thinking the /chat route is missing
            statusCode = 502;
            errorMessage = `Upstream API Error (404): ${error.message}`;
        } else if (error.status) {
            statusCode = error.status;
            errorMessage = error.message;
        }

        if (error.message && error.message.includes('rate_limit')) {
            statusCode = 429;
            errorMessage = 'Rate limit exceeded. Please try again later.';
        }

        console.error(`Sending error response: ${statusCode} - ${errorMessage}`);
        res.status(statusCode).json({ error: errorMessage });
    }
};
