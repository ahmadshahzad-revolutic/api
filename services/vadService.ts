import * as ort from "onnxruntime-node";
import * as path from "path";

export class VADService {
    private session: ort.InferenceSession | null = null;
    private state: ort.Tensor | null = null;
    private sr: ort.Tensor;
    private speechFrames = 0;
    private readonly threshold = 0.75;
    private readonly minSpeechFrames = 10; // ~320ms at 32ms frame size (8kHz)
    private isSpeechDetected = false;

    constructor() {
        // Silero VAD expects 8000 or 16000 sample rate
        this.sr = new ort.Tensor("int64", BigInt64Array.from([8000n]), [1]);
    }

    async init() {
        const modelPath = path.join(__dirname, "..", "models", "silero_vad.onnx");
        console.log(`[VAD] Loading model from: ${modelPath}`);
        this.session = await ort.InferenceSession.create(modelPath);
        this.reset();
    }

    reset() {
        this.state = new ort.Tensor("float32", new Float32Array(2 * 1 * 128).fill(0), [2, 1, 128]);
        this.speechFrames = 0;
        this.isSpeechDetected = false;
    }

    /**
     * Convert u-law (PCMU) to Float32 PCM
     */
    private decodeUlau(buffer: Buffer): Float32Array {
        const l = buffer.length;
        const pcm = new Float32Array(l);
        for (let i = 0; i < l; i++) {
            let u = ~buffer[i];
            let sign = (u & 0x80);
            let exponent = (u & 0x70) >> 4;
            let mantissa = (u & 0x0F);
            let sample = (mantissa << 3) + 132;
            sample <<= (exponent);
            sample -= 132;
            pcm[i] = (sign ? -sample : sample) / 32768.0;
        }
        return pcm;
    }

    private pcmBuffer: Float32Array = new Float32Array(0);

    /**
     * Process an audio chunk (u-law, 8kHz)
     * Returns true if robust speech is detected
     */
    async processAudio(chunk: Buffer): Promise<boolean> {
        if (!this.session || !this.state) return false;

        const newPcm = this.decodeUlau(chunk);

        // Append to buffer
        const combined = new Float32Array(this.pcmBuffer.length + newPcm.length);
        combined.set(this.pcmBuffer);
        combined.set(newPcm, this.pcmBuffer.length);
        this.pcmBuffer = combined;

        const frameSize = 256; // 32ms at 8kHz
        let foundSpeechSignal = false;

        // Process all complete frames in the buffer
        while (this.pcmBuffer.length >= frameSize) {
            const frame = this.pcmBuffer.slice(0, frameSize);
            this.pcmBuffer = this.pcmBuffer.slice(frameSize);

            try {
                const input = new ort.Tensor("float32", frame, [1, frameSize]);
                const feeds: any = {
                    input: input,
                    sr: this.sr,
                    state: this.state
                };

                const results = await this.session.run(feeds);
                this.state = results.stateN;
                const probability = results.output.data[0] as number;

                if (probability > this.threshold) {
                    this.speechFrames++;
                } else {
                    this.speechFrames = Math.max(0, this.speechFrames - 1);
                }

                if (this.speechFrames >= this.minSpeechFrames) {
                    if (!this.isSpeechDetected) {
                        console.log(`[VAD] Speech Detected (prob: ${probability.toFixed(2)}, frames: ${this.speechFrames})`);
                        this.isSpeechDetected = true;
                        foundSpeechSignal = true;
                    }
                } else if (this.speechFrames === 0) {
                    this.isSpeechDetected = false;
                }
            } catch (error) {
                console.error("[VAD] Inference error:", error);
            }
        }

        return this.isSpeechDetected;
    }
}

