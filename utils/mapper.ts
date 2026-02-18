export interface HistoryEntry {
    role: 'user' | 'model' | 'assistant';
    parts?: { text: string }[];
    content?: string;
}

export function mapHistoryToClaude(history: HistoryEntry[]): any[] {
    return (history || []).map((entry) => ({
        role: entry.role === 'model' ? 'assistant' : entry.role,
        content: entry.content || (entry.parts && entry.parts[0]?.text) || ''
    }));
}

export function mapHistoryToGemini(history: HistoryEntry[]): any[] {
    return (history || []).map((entry) => ({
        role: entry.role === 'assistant' ? 'model' : entry.role,
        parts: [{ text: entry.content || (entry.parts && entry.parts[0]?.text) || '' }]
    }));
}
