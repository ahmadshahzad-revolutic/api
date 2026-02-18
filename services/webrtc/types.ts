import { RTCPeerConnection, RTCRtpCodecParameters, MediaStreamTrack, RtpPacket, RtpHeader } from "werift";
import { STTService } from "../voice/sttservice";
import { TTSService } from "../voice/ttsservice";
import { VADService } from "../voice/vadservice";

export interface CallLanguageConfig {
    caller: string;
    receiver: string;
}

export enum CallState {
    LISTENING = 'LISTENING',
    PROCESSING = 'PROCESSING',
    SPEAKING = 'SPEAKING',
    INTERRUPTED = 'INTERRUPTED'
}

export interface AIPeerContext {
    callId: string;
    pc: RTCPeerConnection;
    stt: STTService;
    tts: TTSService;
    vad: VADService;
    chatHistory: any[];
    outputTrack: MediaStreamTrack;
    sequenceNumber: number;
    timestamp: number;
    ssrc: number;
    audioQueue: Buffer;
    pacerInterval: any;
    callLanguages: CallLanguageConfig;
    isTranslationActive: boolean;
    sentenceBuffer: string;
    lastProcessedTranscript: string;
    callerName: string;
    hasSentGreeting: boolean;
    claudeAbortController: AbortController | null;
    isAISpeaking: boolean;
    controlChannel: any;
    isSilencing: boolean;
    lastInterruptionTime: number;
    currentResponseText: string;
    isInterrupted: boolean;
    lastPartialResponse: string;
    lastInterruptedQuestion: string;
    state: CallState;
    silenceTimer: any;
    transcriptBuffer: string;
    userSpeechStartTime: number | null;
    currentMaxConfidence: number;
    lastAudioLevelDb: number;
    peakVolumeThisUtterance: number;
}

export interface AIPeerService {
    pc: RTCPeerConnection;
    isAISpeaking: boolean;
    initializeCall(callerLanguage?: string, receiverLanguage?: string, callerName?: string): void;
    updateCallLanguages(callerLanguage: string, receiverLanguage: string): void;
    createAnswer(offer: any): Promise<any>;
    stop(): Promise<void>;
}
